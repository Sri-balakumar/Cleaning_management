import logging
import re

from odoo import fields, http
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.http import request

from ..models.cleaning_config import (
    DIRECTION_KEYS, MIN_PHOTO_BYTES, MIN_UPLOAD_BYTES,
)

_logger = logging.getLogger(__name__)

DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024

# The upload limit may not fall below what four photographs need.
#
# The administrator's number was chosen with a video in mind. If they lower it
# after switching video off, four phone photographs can still be 24 MB, and
# werkzeug rejects an over-sized body with a bare 413 BEFORE the handler runs -
# so there is no chance to return a readable message and the app shows nothing
# but a failed connection. That is the least debuggable failure in the whole
# feature, so the limit gets a floor whenever photographs are required.
MIN_PHOTO_BUDGET_BYTES = 32 * 1024 * 1024

_FRAME_INDEX = re.compile(r'\d+')


def _frame_sort_key(key):
    """Sort frame_2 before frame_10.

    The two clients name their stills differently: the app sends bare indexes
    (frame_0 ... frame_10) and the browser sends zero-padded names
    (frame_01.jpg). Sorting the raw keys puts frame_10 between frame_1 and
    frame_2, so the stills are stored out of order and the evenly-spaced
    "beginning, middle, end" selection later picks the wrong moments. It only
    bites at ten or more stills, which is exactly the cap on the setting.

    Fixed here rather than only in the app, because app builds already on
    people's phones keep sending the old names for as long as it takes everyone
    to update.
    """
    digits = _FRAME_INDEX.search(key)
    return (0, int(digits.group()), key) if digits else (1, 0, key)


def _cleaning_max_content_length(self):
    """Body size limit for the upload route only.

    Odoo calls this with the controller instance while working out how big a
    request it is willing to read, after the database-wide limit has already
    been applied - so this replaces it for this one route and leaves every other
    upload form in the database alone.
    """
    try:
        config = request.env['cleaning.config'].sudo()._get_for_company()
        if config and config.max_upload_mb > 0:
            limit = config.max_upload_mb * 1024 * 1024
            if config.require_photos:
                limit = max(limit, MIN_PHOTO_BUDGET_BYTES)
            return limit
    except Exception:  # noqa: BLE001 - must never break request handling
        _logger.debug("Falling back to the default cleaning upload limit",
                      exc_info=True)
    return DEFAULT_MAX_UPLOAD_BYTES


def _browser_name(user_agent):
    """Good enough for an audit column; not worth a dependency."""
    if not user_agent:
        return False
    agent = user_agent.lower()
    for needle, label in (
        ('edg/', 'Edge'),
        ('opr/', 'Opera'),
        ('firefox/', 'Firefox'),
        ('chrome/', 'Chrome'),
        ('safari/', 'Safari'),
    ):
        if needle in agent:
            return label
    return 'Other'


class CleaningManagementController(http.Controller):

    def _json_error(self, code, message, status=400):
        return request.make_json_response(
            {'ok': False, 'code': code, 'message': message}, status=status)

    @http.route('/showroom_check/app/token', type='json', auth='user',
                methods=['POST'])
    def app_token(self, **kwargs):
        """Hand the mobile app a CSRF token for the upload route.

        The upload below is a form post and keeps ``csrf=True``, because it
        writes a permanent record attributed to whoever is signed in. A browser
        gets its token embedded in the page; a native app has no page to read
        one from.

        A json route is the right place to serve it: those cannot be triggered
        by a cross-site form post, so handing the token out here is safe -
        certainly safer than a second upload route with the protection removed.
        """
        return {'csrf_token': request.csrf_token()}

    @http.route('/showroom_check/upload', type='http', auth='user',
                methods=['POST'], csrf=True,
                max_content_length=_cleaning_max_content_length)
    def upload(self, slot_id=None, started_at=None, ended_at=None,
               duration_seconds=None, width=None, height=None, mimetype=None,
               file_format=None, truncated=None, latitude=None, longitude=None,
               capture_mode=None, video=None, **kwargs):
        """Receive one recorded clip.

        This is a plain form upload rather than a JSON call on purpose. A large
        JSON body has to be held in memory in full and grows by a third when the
        video is encoded into it, whereas a form upload is streamed to a
        temporary file. It also lets the browser show a real progress bar, which
        matters a great deal when somebody is watching a ninety-second upload.

        Cross-site protection stays on: this route writes a permanent, one-per-
        day record attributed to whoever is signed in.
        """
        try:
            slot = request.env['cleaning.slot'].sudo().browse(int(slot_id or 0))
            if not slot.exists() or not slot.active:
                return self._json_error('bad_slot', request.env._(
                    "This cleaning round no longer exists. Reload the page and "
                    "try again."))

            config = slot.config_id

            # Checked before the body is touched, so somebody without
            # permission is turned away instead of uploading 200 MB first.
            refusal = config._check_user_allowed(request.env.user)
            if refusal:
                return self._json_error('not_allowed', refusal, status=403)

            required = config._required_directions()
            if not config.video_enabled and not required:
                return self._json_error('not_configured', request.env._(
                    "This round would record nothing at all: the video is "
                    "switched off and no original photographs have been set "
                    "up yet.\n\n"
                    "A manager needs to add the original photographs under "
                    "Configuration > Settings, or switch the video back on."))

            # --- the video, now optional ----------------------------------
            blob = b''
            has_video = bool(video and getattr(video, 'filename', None))
            if has_video:
                blob = video.read() or b''

            if config.video_enabled:
                if not has_video:
                    return self._json_error('no_file', request.env._(
                        "No recording was received. Please try again."))
                if len(blob) < MIN_UPLOAD_BYTES:
                    return self._json_error('empty', request.env._(
                        "The recording is empty. The camera may have been "
                        "blocked or disconnected. Check that the camera is "
                        "working, then record again."))
            elif len(blob) < MIN_UPLOAD_BYTES:
                # Video is switched off but a client sent one anyway. Keep it
                # if it is real, ignore it if it is not - either way this is
                # not worth refusing somebody's round over.
                blob = b''
                has_video = False

            # --- the photographs ------------------------------------------
            photos = {}
            for key in DIRECTION_KEYS:
                part = request.httprequest.files.get('photo_%s' % key)
                if not part:
                    continue
                data = part.read() or b''
                if len(data) >= MIN_PHOTO_BYTES:
                    photos[key] = (data, part.mimetype or 'image/jpeg')

            missing = [key for key in required if key not in photos]
            if missing:
                # Named by the manager's own wording, not by the direction key -
                # "Bags area" means something to the person holding the phone
                # and "left" often does not.
                labels = {
                    reference.direction: reference.name
                    for reference in config.reference_image_ids
                }
                return self._json_error('missing_photos', request.env._(
                    "These views were not photographed, or the pictures did "
                    "not arrive: %(views)s.\n\n"
                    "Please take them again.",
                    views=', '.join(labels.get(key, key) for key in missing)))

            size = len(blob)

            started = fields.Datetime.to_datetime(started_at) or fields.Datetime.now()
            local_date = config._local_date(started)
            resolved_mimetype = mimetype or 'video/webm'
            container = (file_format or '').lower()
            if container not in ('webm', 'mp4'):
                container = 'mp4' if 'mp4' in resolved_mimetype else 'webm'

            filename = '%s_%s_%s.%s' % (
                (slot.name or 'round').replace(' ', '_'),
                local_date,
                request.env.user.id,
                container,
            )

            # Not sudo(): created as the real user so that permissions apply and
            # the recording is honestly attributed to whoever made it.
            recording = request.env['cleaning.recording'].create({
                'slot_id': slot.id,
                'slot_date': local_date,
                'user_id': request.env.user.id,
                'started_at': started,
                'ended_at': fields.Datetime.to_datetime(ended_at) or False,
                # Every one of these describes the video. With no video they
                # would be a lie told in a column somebody later reads as fact -
                # a photographs-only round is not "WebM, medium, 0 seconds".
                'duration_seconds': int(float(duration_seconds or 0)) if has_video else 0,
                'configured_duration_seconds': (
                    config.duration_seconds if has_video else 0),
                'quality': config.video_quality if has_video else False,
                'file_format': container if has_video else False,
                'width': int(float(width or 0)) if has_video else 0,
                'height': int(float(height or 0)) if has_video else 0,
                'truncated': (has_video and
                              str(truncated or '').lower() in ('1', 'true', 'yes')),
                # Defaults to 'browser' so the web recorder, which does not send
                # this, keeps recording exactly what it always did.
                'capture_mode': (
                    capture_mode
                    if capture_mode in ('browser', 'mobile', 'manual')
                    else 'browser'),
                'ip_address': request.httprequest.remote_addr,
                'user_agent': request.httprequest.user_agent.string[:512]
                              if request.httprequest.user_agent else False,
                'browser': _browser_name(
                    request.httprequest.user_agent.string
                    if request.httprequest.user_agent else ''),
                'latitude': float(latitude or 0.0),
                'longitude': float(longitude or 0.0),
            })
            if has_video:
                recording._attach_video(blob, filename, resolved_mimetype)

            # Stills captured in the browser while recording. They are what the
            # AI review looks at - neither Gemini nor a local Llama reads video,
            # and pulling frames out server-side would mean installing ffmpeg.
            # Capturing them at record time also picks known moments (start,
            # middle, end) rather than wherever a decoder happens to land.
            frames = []
            for key in sorted((k for k in request.httprequest.files
                               if k.startswith('frame_')), key=_frame_sort_key):
                upload = request.httprequest.files[key]
                data = upload.read()
                if data:
                    frames.append((data, upload.mimetype or 'image/jpeg'))
            if frames:
                recording._store_frames(frames)

            # The photographs last: they are scored as they are stored, and a
            # score is worth nothing if the round it belongs to was refused.
            if photos:
                recording._store_direction_shots([
                    (key, data, part_mimetype,
                     '%s_%s_%s.jpg' % (key, local_date, request.env.user.id))
                    for key, (data, part_mimetype) in photos.items()
                ])

            return request.make_json_response({
                'ok': True,
                'recording_id': recording.id,
                'file_size': recording.file_size,
                'filename': filename if has_video else False,
                'has_video': has_video,
                'shot_count': recording.shot_count,
                'match_score': recording.match_score,
                'match_level': recording.match_level,
                'state': request.env['cleaning.config'].get_dashboard_state(),
            })

        except (AccessError, ValidationError, UserError) as exc:
            # Rolled back so a half-written recording is not left behind, then
            # reported as JSON - the page needs a message it can display, not an
            # error page it cannot read.
            request.env.cr.rollback()
            return self._json_error('rejected', str(exc), status=403)
        except Exception:  # noqa: BLE001
            request.env.cr.rollback()
            _logger.exception("Cleaning recording upload failed")
            return self._json_error('server_error', request.env._(
                "The recording could not be saved because of a problem on the "
                "server. Your recording is still on this page - please try "
                "again, or save it and send it to your administrator."),
                status=500)

    @http.route('/showroom_check/video/<int:recording_id>', type='http',
                auth='user', methods=['GET'])
    def video(self, recording_id, **kwargs):
        """Play a stored recording.

        Deliberately not sudo(): access to the stored video follows this
        record's own permissions, which is what stops one cleaner watching
        another's clip.
        """
        recording = request.env['cleaning.recording'].browse(recording_id)
        if not recording.exists() or not recording.video_file:
            return request.not_found()
        # This produces a response the browser can seek within, so the video
        # player's scrub bar works instead of having to download the whole file
        # before it will play.
        return request.env['ir.binary']._get_stream_from(
            recording, 'video_file',
            filename=recording.video_filename,
            filename_field='video_filename',
        ).get_response(
            as_attachment=False,
            # A stored recording is written once and never edited, so the bytes
            # behind a given id cannot change: deleting it frees the id (404),
            # retention clears the file (also 404), and Postgres never reuses a
            # sequence value. That makes it genuinely immutable, so re-watching
            # comes from the browser cache with no request at all instead of a
            # revalidation round trip.
            #
            # Odoo already marks this Cache-Control: private (Stream.public is
            # False for a signed-in user), so it is cached by that person's
            # browser and never by a shared proxy - which is what we want for
            # footage that is access-controlled.
            immutable=True,
        )

    @http.route('/showroom_check/photo/<int:shot_id>', type='http',
                auth='user', methods=['GET'])
    def photo(self, shot_id, **kwargs):
        """Serve one of a round's photographs.

        Same shape as the video route above, and not sudo() for the same
        reason: the record rules on the photograph decide who may see it, which
        is what stops one person browsing another's rounds.

        Immutable for the same reason too - a photograph taken on a round is
        written once and never replaced. The ORIGINALS are the opposite, which
        is why they are served through /web/image with a cache-busting stamp
        rather than through here.
        """
        shot = request.env['cleaning.recording.shot'].browse(shot_id)
        if not shot.exists() or not shot.image:
            return request.not_found()
        return request.env['ir.binary']._get_stream_from(
            shot, 'image',
            filename=shot.image_filename,
            filename_field='image_filename',
        ).get_response(as_attachment=False, immutable=True)
