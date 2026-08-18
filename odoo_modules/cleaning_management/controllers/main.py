import logging

from odoo import fields, http
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.http import request

from ..models.cleaning_config import MIN_UPLOAD_BYTES

_logger = logging.getLogger(__name__)

DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024


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
            return config.max_upload_mb * 1024 * 1024
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

    @http.route('/cleaning_management/app/token', type='json', auth='user',
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

    @http.route('/cleaning_management/upload', type='http', auth='user',
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

            if not video or not getattr(video, 'filename', None):
                return self._json_error('no_file', request.env._(
                    "No recording was received. Please try again."))

            blob = video.read()
            size = len(blob or b'')
            if size < MIN_UPLOAD_BYTES:
                return self._json_error('empty', request.env._(
                    "The recording is empty. The camera may have been blocked "
                    "or disconnected. Check that the camera is working, then "
                    "record again."))

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
                'duration_seconds': int(float(duration_seconds or 0)),
                'configured_duration_seconds': config.duration_seconds,
                'quality': config.video_quality,
                'file_format': container,
                'width': int(float(width or 0)),
                'height': int(float(height or 0)),
                'truncated': str(truncated or '').lower() in ('1', 'true', 'yes'),
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
            recording._attach_video(blob, filename, resolved_mimetype)

            # Stills captured in the browser while recording. They are what the
            # AI review looks at - neither Gemini nor a local Llama reads video,
            # and pulling frames out server-side would mean installing ffmpeg.
            # Capturing them at record time also picks known moments (start,
            # middle, end) rather than wherever a decoder happens to land.
            frames = []
            for key in sorted(k for k in request.httprequest.files
                              if k.startswith('frame_')):
                upload = request.httprequest.files[key]
                data = upload.read()
                if data:
                    frames.append((data, upload.mimetype or 'image/jpeg'))
            if frames:
                recording._store_frames(frames)

            return request.make_json_response({
                'ok': True,
                'recording_id': recording.id,
                'file_size': recording.file_size,
                'filename': filename,
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

    @http.route('/cleaning_management/video/<int:recording_id>', type='http',
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
