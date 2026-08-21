import logging
import re

from markupsafe import Markup

from odoo import fields, http
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.http import request

from ..models import cleaning_image_compare as compare
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


# The shell every guide is served in: the head, the bar across the top and the
# column the guide itself sits in. Four placeholders, in order: the title twice
# (the tab and the bar), the PDF button, and the guide body.
#
# Every literal percent below is DOUBLED, because this is filled in with the %
# operator and a single one there raises "unsupported format character" on the
# request rather than at import - so it would ship green and 500 in front of a
# reader.
#
# The stylesheet lives here rather than inside each guide because the guides are
# written as fragments - headings, paragraphs, lists and nothing else. Styling
# them from the shell means a guide typed into the web form months from now
# arrives looking like the two that ship with the module, without whoever wrote
# it having to know any of this.
_GUIDE_PAGE = (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>'
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>'
    '<title>%s</title>'
    '<style>'
    'body{margin:0;font-family:"Segoe UI",Arial,sans-serif;color:#222;}'
    '.bar{position:sticky;top:0;z-index:5;background:#2f3b8c;color:#fff;'
    'padding:11px 18px;display:flex;align-items:center;'
    'justify-content:space-between;gap:16px;}'
    '.bar h1{margin:0;font-weight:bold;font-size:16px;}'
    '.btn{background:#fff;color:#2f3b8c;border:none;border-radius:6px;'
    'padding:7px 14px;font-weight:600;text-decoration:none;white-space:nowrap;}'
    # Everything below is scoped to .g, and the names are the HR suite's own
    # (.g, .note, .flow). A guide written for one of those modules can be
    # dropped in here and will look exactly as it did there.
    '.g{max-width:980px;margin:0 auto;padding:24px;line-height:1.6;color:#222;}'
    '.g h1{color:#875A7B;font-size:24px;margin:0 0 6px;}'
    '.g h2{color:#875A7B;border-bottom:2px solid #875A7B;padding-bottom:5px;'
    'margin-top:26px;font-size:19px;}'
    '.g h3{color:#5d3f54;margin-top:18px;font-size:15px;}'
    '.g table{border-collapse:collapse;width:100%%;margin:10px 0;font-size:14px;}'
    '.g th,.g td{border:1px solid #e3dde2;padding:7px 10px;text-align:left;'
    'vertical-align:top;}'
    '.g th{background:#875A7B;color:#fff;}'
    '.g tr:nth-child(even) td{background:#faf7f9;}'
    '.g code{background:#f3eef2;padding:1px 6px;border-radius:4px;'
    'font-family:Consolas,monospace;}'
    '.g a{color:#2f3b8c;}'
    '.g .note{background:#fff3cd;border:1px solid #e0c97a;border-radius:6px;'
    'padding:10px 14px;margin:12px 0;}'
    '.g .flow{background:#f7f4f6;border:1px solid #e3dde2;border-radius:6px;'
    'padding:10px 14px;font-family:Consolas,monospace;font-size:13px;'
    'white-space:pre-wrap;}'
    '.g .muted{color:#6b5c66;}'
    # The HR guides carry no pictures, so these two have no counterpart to copy
    # and are written to sit inside the same palette: a plum-grey frame, and a
    # caption quiet enough to read as a label rather than as more prose.
    '.g .shot{margin:18px 0 4px;text-align:center;}'
    '.g .shot img{max-width:100%%;height:auto;border:1px solid #e3dde2;'
    'border-radius:6px;}'
    '.g img{max-width:100%%;height:auto;}'
    '.g .caption{margin:0 0 20px;text-align:center;color:#6b5c66;font-size:13px;'
    'font-style:italic;}'
    # A guide is read at length and sometimes printed. The bar is a navigation
    # device and means nothing on paper.
    '@media print{.bar{display:none;}.g{max-width:none;padding:0;}}'
    '</style></head>'
    '<body>'
    '<div class="bar"><h1>%s</h1>%s</div>'
    '<div class="g">%s</div>'
    '</body></html>'
)


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
               capture_mode=None, capture_kind=None, video=None, **kwargs):
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

            # How this round was captured, where the client said so.
            #
            # Absent on every upload the web recorder sends and on every older
            # app, and that is a third answer rather than a default: those
            # clients record whatever the settings say, so the rules below stay
            # exactly as they were for them. Only a client that explicitly asks
            # for one of the two modes gets the new behaviour.
            kind = capture_kind if capture_kind in ('video', 'photographs') else None
            wants_video = config.video_enabled if kind is None else kind == 'video'

            required = config._required_directions()
            # "Nothing to record" means no clip AND no view worth photographing,
            # which is the ASKABLE list - not the required one.
            #
            # Gating this on required refused every photographs-only round in
            # any office that had not switched `require_photos` on, however many
            # originals it had set up: required is empty whenever the setting is
            # off, so the server told somebody who had just walked the room and
            # photographed it that there was nothing to record.
            if not wants_video and not config._askable_directions():
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

            if wants_video:
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

            # Named by the manager's own wording, not by the direction key -
            # "Bags area" means something to the person holding the phone and
            # "left" often does not. _ensure_reference_rows guarantees a row per
            # direction, so a view with no picture on it still has a name.
            labels = {
                reference.direction: reference.name
                for reference in config.reference_image_ids
            }

            # --- the photographs ------------------------------------------
            #
            # Kept only where there is an original to compare against. A
            # photograph of a view with no original can never be scored - not
            # today and not after somebody adds the original next month, because
            # the shot records which original it was taken against and that
            # would be nothing. Storing it would leave a picture nobody can act
            # on sitting in every round for as long as the retention setting
            # says, reading in the form as a comparison that failed.
            #
            # Tested against the ASKABLE directions, never the required ones:
            # required is empty whenever require_photos is off, which would
            # discard every photograph from every office that has not switched
            # the requirement on - which is all of them to begin with.
            askable = set(config._askable_directions())
            photos = {}
            ignored = []
            for key in DIRECTION_KEYS:
                part = request.httprequest.files.get('photo_%s' % key)
                if not part:
                    continue
                data = part.read() or b''
                if len(data) < MIN_PHOTO_BYTES:
                    continue
                if key not in askable:
                    # Read off the wire and dropped. Not a refusal: the round
                    # itself is fine, and somebody who photographed one view too
                    # many has done nothing wrong.
                    ignored.append(key)
                    continue
                photos[key] = (data, part.mimetype or 'image/jpeg')

            # A video round photographs nothing, and is not missing anything
            # for it: the views are read back out of the recording below, and
            # any the sweep never showed is recorded as unseen with a reason on
            # it. Holding it to the photograph rule would refuse the one mode
            # that exists so nobody has to take them.
            missing = [] if kind == 'video' else [
                key for key in required if key not in photos]
            if missing:
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
                # Left empty where the client did not say, which is honest: a
                # round uploaded before there was a choice was not "a video
                # round", it was the only kind of round there was.
                'capture_kind': kind or False,
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
            # AI review looks at - neither Gemini nor a local Llama reads video.
            # Capturing them at record time picks known moments (start, middle,
            # end) rather than wherever a decoder happens to land.
            #
            # A video round does not send these: it has the whole recording, so
            # _extract_shots_from_video below cuts its own stills out of it and
            # stores them the same way. Hence the check before storing - the
            # extraction skips it entirely if stills are already here.
            frames = []
            for key in sorted((k for k in request.httprequest.files
                               if k.startswith('frame_')), key=_frame_sort_key):
                upload = request.httprequest.files[key]
                data = upload.read()
                if data:
                    frames.append((data, upload.mimetype or 'image/jpeg'))
            if frames:
                recording._store_frames(frames)

            # A video round: read its views back out of the recording it just
            # sent. Inline, because somebody who has finished a round should be
            # told what it scored rather than come back to it later, and because
            # the response below already carries the verdict.
            #
            # After the clip is attached, never instead of it. The recording is
            # what was uploaded and what is kept; these are a reading of it.
            if kind == 'video' and has_video:
                recording._extract_shots_from_video()

            # The photographs last: they are scored as they are stored, and a
            # score is worth nothing if the round it belongs to was refused.
            if photos:
                recording._store_direction_shots([
                    (key, data, part_mimetype,
                     '%s_%s_%s.jpg' % (key, local_date, request.env.user.id))
                    for key, (data, part_mimetype) in photos.items()
                ])

            # Said out loud rather than dropped in silence. Somebody who took
            # the trouble to photograph a fifth view deserves to know it was not
            # kept and why - otherwise they carry on taking it every morning,
            # and a manager who sees only three pictures thinks the app is
            # broken. A warning beside a successful round, never an error: the
            # round itself is complete.
            warning = False
            if ignored:
                warning = request.env._(
                    "These views were not saved: %(views)s.\n\n"
                    "No original photograph has been set for them, so there is "
                    "nothing to compare them against. The rest of your round "
                    "went through. If they should be checked, ask a manager to "
                    "add their originals under Configuration > Settings.",
                    views=', '.join(labels.get(key, key) for key in ignored))

            return request.make_json_response({
                'ok': True,
                'recording_id': recording.id,
                'file_size': recording.file_size,
                'filename': filename if has_video else False,
                'has_video': has_video,
                'ignored_photos': [
                    {'key': key, 'label': labels.get(key, key)}
                    for key in ignored
                ],
                'warning': warning,
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

    @http.route('/showroom_check/match_proof/<int:shot_id>', type='http',
                auth='user', methods=['GET'])
    def match_proof(self, shot_id, **kwargs):
        """The matched features drawn across both photographs.

        Not sudo(), like the two routes below it: the record rules on the
        photograph decide who may look at it, and the proof of a comparison
        is no more public than the pictures it is drawn on.

        Computed per request rather than stored. It is looked at when
        somebody doubts a number, which is rarely, and keeping a second
        image against every photograph ever taken to save that would be a
        poor trade.
        """
        shot = request.env['cleaning.recording.shot'].browse(shot_id)
        if not shot.exists() or not shot.image:
            return request.not_found()
        reference = shot.reference_image_id
        if not reference or not reference.image:
            return request.not_found()

        drawing = compare.match_drawing(
            reference._raw_image(), shot._raw_image(),
            everything=kwargs.get('all') in ('1', 'true', 'True'))
        if not drawing:
            return request.not_found()
        return request.make_response(drawing, headers=[
            ('Content-Type', 'image/png'),
            ('Content-Length', str(len(drawing))),
            ('Cache-Control', 'no-store'),
        ])

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

    @http.route('/showroom_check/help/guide/<int:manual_id>', type='http',
                auth='user', methods=['GET'])
    def help_guide(self, manual_id, **kwargs):
        """A guide, as a page anyone can read, with the PDF one click away.

        The model returns the body only; the shell is built here. The app
        builds its own for the same body, because a phone has no session
        cookie to open a URL with -- which is why this is not the app's route.

        The audience is checked by get_guide rather than repeated here: a URL
        typed by hand deserves the same answer as the button that normally
        opens it.
        """
        manual = request.env['cleaning.manual']
        guide = manual.get_guide(manual_id)
        if not guide:
            return request.not_found()

        # Everything below goes through Markup's % operator, which escapes a
        # plain string and lets anything carrying __html__ through untouched.
        # That is the whole difference between a title and a guide: the title is
        # a value somebody typed, the guide is markup somebody wrote.
        #
        # Never build this page by adding strings together. Markup defines
        # __radd__, so 'literal' + markup escapes the LITERAL and hands back a
        # Markup that escapes everything added after it - which turns the whole
        # page into visible source and is exactly the bug this replaces.
        body = Markup(guide['html']) if guide['html'] else Markup(
            '<p class="muted">This guide has not been written yet.</p>')

        button = Markup('')
        if guide['has_pdf']:
            pdf_url = manual.sudo().browse(manual_id).pdf_url or ''
            button = Markup(
                '<a class="btn" href="%s" target="_blank" rel="noopener">'
                '&#128196; Open in PDF doc</a>') % pdf_url

        title = guide['name'] or 'Guide'
        html = Markup(_GUIDE_PAGE) % (title, title, button, body)
        return request.make_response(html, headers=[
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Cache-Control', 'no-store'),
        ])
