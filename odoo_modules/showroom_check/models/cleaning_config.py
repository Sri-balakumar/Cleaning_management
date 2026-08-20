import logging
from datetime import datetime, time

import pytz

from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


# A single recording may not exceed this, whatever the admin types.
#
# The limit is NOT disk space - it is `limit_time_real = 120` in odoo.conf. The
# worker is killed if the whole POST takes longer than 120 seconds of wall
# clock, and the time spent receiving the upload counts towards that. At Medium
# quality 5 minutes of video is ~94 MB, which is already ~75 s of transfer on a
# realistic 10 Mbit office uplink. Anything longer fails *intermittently*, which
# is the worst kind of failure to debug.
#
# If an hour of footage is ever genuinely needed, the answer is a chunked upload
# (many short requests), not a bigger number here.
MAX_DURATION_SECONDS = 300

# Refuse an upload smaller than this. A camera that was blocked mid-negotiation
# can produce a valid-looking container with no frames in it; storing those
# would also make them deduplicate against each other in the content-addressed
# filestore, so several "recordings" would share one empty file.
MIN_UPLOAD_BYTES = 4096

DURATION_UNIT_SECONDS = {
    'seconds': 1,
    'minutes': 60,
    'hours': 3600,
}

# Resolved server-side and sent to the browser as plain numbers, so adding a
# tier is a one-file change and the two sides cannot drift apart.
QUALITY_PRESETS = {
    'low': {
        'width': 640, 'height': 480, 'frame_rate': 15, 'video_bitrate': 800000,
    },
    'medium': {
        # 1.5 Mbps, not the 2.5 this started at. What gets filmed here is a
        # room with very little movement in it, and an encoder has almost
        # nothing to spend the extra bits on - 720p at 1.5 looks the same as at
        # 2.5 for this subject, while every recording becomes ~40% smaller to
        # upload, store and load back.
        'width': 1280, 'height': 720, 'frame_rate': 24, 'video_bitrate': 1500000,
    },
    'high': {
        'width': 1920, 'height': 1080, 'frame_rate': 30, 'video_bitrate': 5000000,
    },
}

# Ordered candidate lists handed to MediaRecorder.isTypeSupported() in the
# browser. The first supported entry wins; if none of the preferred container's
# entries work the client falls back to the other container rather than
# refusing to record, because a WebM clip is far more useful than no clip.
MIMETYPE_CANDIDATES = {
    'webm': [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
    ],
    'mp4': [
        # avc1.42E01E is H.264 Constrained Baseline L3.0 - the profile
        # Chromium's MediaRecorder actually muxes and every player can decode.
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4',
    ],
}

DEFAULT_SLOTS = [
    {'name': 'Morning Round', 'day_period': 'morning',
     'hour_from': 9.0, 'hour_to': 10.0, 'sequence': 10},
    {'name': 'Afternoon Round', 'day_period': 'afternoon',
     'hour_from': 14.0, 'hour_to': 15.0, 'sequence': 20},
    {'name': 'Evening Round', 'day_period': 'evening',
     'hour_from': 18.0, 'hour_to': 19.0, 'sequence': 30},
]


# The four views of the room, in the order somebody turning on the spot meets
# them. The key is fixed forever and is what everything matches on - the label
# beside it is the manager's own wording ("Systems", "Bags area"), may be edited
# at any time, and so may never be keyed off by anything.
DIRECTIONS = [
    ('front', 'Front'),
    ('right', 'Right'),
    ('back', 'Back'),
    ('left', 'Left'),
]
DIRECTION_KEYS = [key for key, _label in DIRECTIONS]

# Sequence numbers rather than list position, so the four rows sort identically
# in the settings form, in the prompt and in the picture list without all three
# having to agree to sort by anything in particular.
DIRECTION_SEQUENCE = {'front': 10, 'right': 20, 'back': 30, 'left': 40}

# Where each view lies for somebody standing in the middle of the room, as a
# compass bearing in degrees.
#
# Here rather than in the app, because working out the turn between two views
# needs to know WHICH views a round actually walks - and only this side knows
# that. A round covers the views that have an original, so an office with front
# and left set up turns a quarter to the LEFT between them; a client assuming
# four evenly spaced views would confidently send somebody the other way, to a
# wall nobody is checking.
DIRECTION_BEARING = {'front': 0, 'right': 90, 'back': 180, 'left': 270}


def turn_between(from_direction, to_direction):
    """The shortest way round from one view to the next.

    ``{'degrees': 90, 'clockwise': True}`` - clockwise being a turn to the
    person's right. Returns None when either direction is unknown, which the
    client reads as "no turn to show" rather than as zero.
    """
    start = DIRECTION_BEARING.get(from_direction)
    end = DIRECTION_BEARING.get(to_direction)
    if start is None or end is None:
        return None
    delta = (end - start) % 360
    return ({'degrees': delta, 'clockwise': True} if delta <= 180
            else {'degrees': 360 - delta, 'clockwise': False})

DIRECTION_DEFAULT_LABEL = {
    'front': 'Front view',
    'right': 'Right side',
    'back': 'Back view',
    'left': 'Left side',
}

# Refuse a photograph smaller than this, for the same reason MIN_UPLOAD_BYTES
# exists: a camera that failed part-way through still produces a small but
# perfectly valid JPEG, and comparing one of those against the original would
# report a change that never happened.
MIN_PHOTO_BYTES = 2048

# Every showroom photograph is stored at this size, not at whatever the phone
# produced. Both the originals and the rounds measured against them, because a
# comparison between a 12 megapixel original and a bounded round photograph is a
# comparison between two different pictures.
#
# A 12 megapixel JPEG is around 5 MB. Four a day for ninety days is 1.8 GB per
# company, for detail nobody will ever look at: 1600px is far more than enough
# to see that a bag is missing, and it also bounds what has to be base64'd into
# an AI request later.
STORED_LONG_EDGE = 1600
STORED_QUALITY = 82

# How far back a photographs-only round may claim to have started.
#
# The video path allows `duration_seconds + upload_grace_seconds`, but
# duration_seconds describes a video, and with video switched off it is zero -
# which would leave somebody who took a minute to walk the room being told
# their round was backdated. Five minutes is a walk around an office at a
# normal pace with four stops.
PHOTO_ROUND_SECONDS = 300

# What a match score means, in words. The BAND is what a manager reads, never
# the raw number: a good match between two photographs of the same room taken
# hours apart genuinely lands in the seventies, and "72%" sitting next to a
# threshold of 60 reads like a near miss when it is nothing of the sort.
MATCH_LEVELS = [
    ('ok', 'As expected'),
    ('warn', 'Worth a look'),
    ('alert', 'Something has changed'),
    # Compared, and the answer was that it could not be answered. Its own
    # band because 'Not compared' is untrue of it and reads as a fault: the
    # comparison ran, found the same view, and could not line the two up
    # closely enough for the score to mean anything.
    ('unaligned', 'Could not line up'),
    ('unknown', 'Not compared'),
]

# The dHash distance, out of 64, past which two pictures are probably not of
# the same view at all rather than the same view with something moved.
#
# Identical pictures are 0. The same room from the same spot hours apart lands
# in the low teens. Pure chance is 32. The pair that prompted this - an
# original framed as a close-up of one corner, against a round photographed
# from across the room - came in at 29 and 25.
#
# 22 is deliberately high. A room that genuinely changed still shares its
# framing and moves only a handful of bits, so this must not fire on one: the
# point is to explain a verdict, never to explain one away. Provisional, and
# worth calibrating against real rounds once the originals are retaken.
VIEW_MISMATCH_DISTANCE = 22


def float_to_time(value):
    """Turn a wall-clock float into a ``datetime.time``. ``9.5`` -> ``09:30``.

    Rounds to whole minutes and carries properly, so ``9.999`` becomes 10:00
    rather than ``time(9, 60)``, which raises. ``24.0`` clamps to the last
    microsecond of the day - the same convention resource.calendar.attendance
    documents on its hour_from field.
    """
    value = max(0.0, min(float(value or 0.0), 24.0))
    if value >= 24.0:
        return time(23, 59, 59, 999999)
    hours = int(value)
    minutes = int(round((value - hours) * 60))
    if minutes == 60:
        hours, minutes = hours + 1, 0
    if hours >= 24:
        return time(23, 59, 59, 999999)
    return time(hours, minutes)


def format_float_time(value):
    """``9.5`` -> ``'09:30'``, for use inside user-facing messages."""
    moment = float_to_time(value)
    return '%02d:%02d' % (moment.hour, moment.minute)


def _tz_get(self):
    return [
        (name, name)
        for name in sorted(
            pytz.all_timezones,
            key=lambda tz: tz if not tz.startswith('Etc/') else '_',
        )
    ]


class CleaningConfig(models.Model):
    _name = 'cleaning.config'
    _description = 'Cleaning Recording Configuration'
    _order = 'company_id, id'

    name = fields.Char(
        string='Name', required=True, default='Cleaning Recording Settings')
    active = fields.Boolean(string='Active', default=True)
    company_id = fields.Many2one(
        'res.company', string='Company', required=True, index=True,
        ondelete='cascade', default=lambda self: self.env.company)

    # --- Schedule ---------------------------------------------------------
    timezone = fields.Selection(
        _tz_get, string='Office Timezone', required=True,
        default=lambda self: self.env.user.tz or 'UTC',
        help="The whole schedule is anchored to THIS timezone, not to each "
             "user's own profile timezone. A supervisor reviewing from another "
             "country must still see the same 09:00-10:00 window as the "
             "cleaner standing in the office - and many users have no timezone "
             "set on their profile at all.")
    slot_ids = fields.One2many(
        'cleaning.slot', 'config_id', string='Time Slots')
    slot_count = fields.Integer(
        string='Times Per Day', compute='_compute_slot_count', store=True,
        help="How many cleaning rounds happen per day. This follows the time "
             "slots below - add or remove a slot to change it.")

    # --- The originals ----------------------------------------------------
    reference_image_ids = fields.One2many(
        'cleaning.reference.image', 'config_id', string='Original Photographs')
    reference_count = fields.Integer(
        string='Originals Set', compute='_compute_reference_count',
        help="How many of the four views have an original photograph. Views "
             "without one are not asked for and not scored.")

    require_photos = fields.Boolean(
        string='Require the photographs', default=False,
        help="When this is on, a round is refused unless it carries a "
             "photograph for every view that has an original.\n\n"
             "Off to begin with, and that is deliberate. Set the originals up "
             "first, check they look right, and make sure everybody's app can "
             "actually send photographs - THEN turn this on. Switching it on "
             "any earlier stops people recording at all, on the same morning "
             "you set the originals up.")

    # --- Warnings ---------------------------------------------------------
    #
    # Two numbers rather than one, because "worth a look" and "something is
    # wrong" are different messages and a manager should be able to set the
    # distance between them.
    match_warn_threshold = fields.Integer(
        string='Warn Below', default=60,
        help="A view scoring below this is flagged as worth a look.\n\n"
             "Sixty is a starting point, not a measurement. Two photographs of "
             "an unchanged room taken hours apart score in the seventies or "
             "eighties, and something genuinely missing scores far lower - but "
             "where exactly your rooms land depends on your camera and your "
             "lighting. Leave it for a week, then look at the Low Match report "
             "and move it to suit what you actually see.")
    match_alert_threshold = fields.Integer(
        string='Alert Below', default=50,
        help="A view scoring below this is flagged red: something has changed.")

    # --- Recording --------------------------------------------------------
    video_enabled = fields.Boolean(
        string='Also record a video', default=True,
        help="Turn this off to make a round four photographs and nothing "
             "else.\n\n"
             "The photographs are what the room is checked against. The video "
             "is a record of who was there and what they did, which is worth "
             "keeping but costs far more to upload and store.")
    duration_value = fields.Integer(
        string='Recording Duration', required=True, default=60)
    duration_unit = fields.Selection(
        [('seconds', 'Seconds'), ('minutes', 'Minutes'), ('hours', 'Hours')],
        string='Duration Unit', required=True, default='seconds')
    duration_seconds = fields.Integer(
        string='Duration (seconds)', compute='_compute_duration_seconds',
        store=True,
        help="The recording length in seconds, whatever unit was used above.")
    video_format = fields.Selection(
        [('webm', 'WebM - works in Chrome, Edge and Firefox'),
         ('mp4', 'MP4 - only where the browser can record it')],
        string='Video Format', required=True, default='webm',
        help="WebM recording is available in every supported browser. MP4 "
             "recording is only available in Safari and recent Chromium; "
             "elsewhere the recording falls back to WebM automatically and the "
             "actual format is stored on the recording.")
    video_quality = fields.Selection(
        [('low', 'Low - 480p'),
         ('medium', 'Medium - 720p'),
         ('high', 'High - 1080p')],
        string='Video Quality', required=True, default='medium')
    camera_facing = fields.Selection(
        [('environment', 'Rear / room-facing camera'),
         ('user', 'Front / selfie camera')],
        string='Which side (phones only)', required=True, default='environment',
        help="Applies ONLY to phones and tablets, which have a camera on each "
             "side. A laptop or desktop has one camera and ignores this "
             "completely.\n\n"
             "To choose between several cameras attached to a computer, use "
             "the Test camera button - that choice is made per computer, since "
             "two recording stations will have different cameras.")
    estimated_size_mb = fields.Float(
        string='Estimated Size Per Recording (MB)',
        compute='_compute_estimated_size_mb', digits=(10, 1),
        help="Duration multiplied by the bitrate for the chosen quality. Shown "
             "so the storage cost is visible before the duration is raised.")

    # --- Access -----------------------------------------------------------
    allowed_user_mode = fields.Selection(
        [('group', 'Anyone with the Showroom Check "User" role'),
         ('list', 'Only the users listed below')],
        string='Who Can Record', required=True, default='group',
        help="Choose explicitly rather than relying on an empty list meaning "
             "'everybody', which is ambiguous once somebody else maintains it.")
    allowed_user_ids = fields.Many2many(
        'res.users', 'cleaning_config_allowed_users_rel', 'config_id', 'user_id',
        string='Allowed Users', domain="[('share', '=', False)]",
        help="Checked on the server when the recording is saved, not just by "
             "graying out the dashboard button.")
    upload_grace_seconds = fields.Integer(
        string='Upload Grace Period (seconds)', default=300,
        help="A recording legitimately started 20 seconds before the window "
             "closed still has to finish and upload afterwards. The start time "
             "must fall inside the window; the upload itself is accepted for "
             "this many seconds after the window closed.")

    # --- Retention --------------------------------------------------------
    retention_number = fields.Integer(
        string='Keep Recordings For', default=30,
        help="Use 0 to keep recordings forever.")
    retention_unit = fields.Selection(
        [('days', 'Days'), ('weeks', 'Weeks'), ('months', 'Months')],
        string='Retention Unit', required=True, default='days')
    retention_mode = fields.Selection(
        [('purge_video', 'Delete the video, keep the log entry'),
         ('delete', 'Delete the whole record')],
        string='On Expiry', required=True, default='purge_video',
        help="The video is the entire storage cost; the log entry ('Morning "
             "round, 1 May, recorded by Ravi at 09:14') is a few hundred bytes "
             "and is what answers a later question. Deleting the whole record "
             "also makes that day show up as a MISSED round in the report, "
             "which is misleading.\n\n"
             "Note: free disk space does not go up at the moment of deletion. "
             "The file is marked, then removed on a later cleanup pass.")
    max_upload_mb = fields.Integer(
        string='Maximum Upload Size (MB)', default=256,
        help="Applies only to the cleaning upload page. Every other upload "
             "form in the database keeps its own separate limit.")

    _uniq_company = models.Constraint(
        'UNIQUE (company_id)',
        'This company already has a cleaning recording configuration.',
    )
    _check_duration_value = models.Constraint(
        'CHECK (duration_value > 0)',
        'The recording duration must be greater than zero.',
    )
    _check_retention_number = models.Constraint(
        'CHECK (retention_number >= 0)',
        'Retention cannot be negative. Use 0 to keep recordings forever.',
    )
    _check_max_upload = models.Constraint(
        'CHECK (max_upload_mb > 0)',
        'The maximum upload size must be greater than zero.',
    )
    _check_match_thresholds = models.Constraint(
        'CHECK (match_alert_threshold >= 0 '
        'AND match_warn_threshold <= 100 '
        'AND match_alert_threshold <= match_warn_threshold)',
        'The alert level must be at or below the warning level, and both '
        'between 0 and 100.',
    )

    # ------------------------------------------------------------------
    # Computes and constraints
    # ------------------------------------------------------------------
    @api.depends('slot_ids', 'slot_ids.active')
    def _compute_slot_count(self):
        for config in self:
            config.slot_count = len(config.slot_ids.filtered('active'))

    @api.depends('duration_value', 'duration_unit')
    def _compute_duration_seconds(self):
        for config in self:
            factor = DURATION_UNIT_SECONDS.get(config.duration_unit, 1)
            config.duration_seconds = max(1, (config.duration_value or 0) * factor)

    @api.depends('duration_seconds', 'video_quality')
    def _compute_estimated_size_mb(self):
        for config in self:
            preset = QUALITY_PRESETS.get(config.video_quality) or QUALITY_PRESETS['medium']
            byte_estimate = preset['video_bitrate'] / 8.0 * config.duration_seconds
            config.estimated_size_mb = byte_estimate / (1024.0 * 1024.0)

    @api.depends('reference_image_ids', 'reference_image_ids.image')
    def _compute_reference_count(self):
        for config in self:
            config.reference_count = len(
                config.reference_image_ids.filtered('image'))

    @api.constrains('duration_value', 'duration_unit', 'video_quality',
                    'video_enabled')
    def _check_duration(self):
        """Refuse a configuration that would fail at upload time.

        Telling the administrator now, with the real number in the message, is
        far kinder than letting a cleaner discover it at 09:00 when their
        recording dies after two minutes of uploading.

        Skipped entirely when video is switched off: "your video is too long"
        is a confusing thing to be told about a setting that is not in use, and
        it would block saving over a leftover value nobody can even see.
        """
        for config in self:
            if not config.video_enabled:
                continue
            if config.duration_seconds > MAX_DURATION_SECONDS:
                raise ValidationError(self.env._(
                    "A single recording cannot be longer than %(max)s minutes.\n\n"
                    "At %(quality)s quality, %(asked)s would produce a file of "
                    "roughly %(size).0f MB. This server stops any request that "
                    "takes more than 2 minutes, so an upload that large would be "
                    "cut off before it finished.\n\n"
                    "Record a short clip at the start of each round instead - "
                    "30 to 60 seconds is enough to show who arrived and when.",
                    max=MAX_DURATION_SECONDS // 60,
                    quality=dict(self._fields['video_quality'].selection).get(
                        config.video_quality, config.video_quality),
                    asked="%s %s" % (config.duration_value, config.duration_unit),
                    size=config.estimated_size_mb,
                ))

    # ------------------------------------------------------------------
    # Timezone helpers - the schedule's single source of truth
    # ------------------------------------------------------------------
    def _tz(self):
        """The timezone the schedule is anchored to.

        Deliberately NOT ``self.env.tz``. That resolves to the *user's*
        timezone, which would make the same 09:00 window open at different real
        moments for different people - and it is unset on many user profiles,
        in which case it silently falls back to UTC.
        """
        name = (self.timezone if self else None) \
            or self.env.company.partner_id.tz \
            or self.env.user.tz \
            or 'UTC'
        try:
            return pytz.timezone(name)
        except pytz.UnknownTimeZoneError:
            _logger.warning("Unknown timezone %r on cleaning.config, using UTC", name)
            return pytz.utc

    def _local_now(self, now_utc=None):
        """Naive-UTC datetime -> timezone-aware datetime in the office timezone."""
        now_utc = now_utc or fields.Datetime.now()
        # pytz.utc.localize(), never .replace(tzinfo=...): a pytz zone object
        # carries its Local Mean Time offset (+05:53 for Kolkata) until it has
        # been localized, so .replace() silently produces a time that is minutes
        # off.
        return pytz.utc.localize(now_utc).astimezone(self._tz())

    def _local_date(self, now_utc=None):
        """Today's date **in the office timezone**.

        Not ``fields.Date.context_today()``, which uses the user's timezone. At
        23:30 in India those two return different dates, so every "already
        recorded today" check would disagree with the row that was written.
        """
        return self._local_now(now_utc).date()

    # ------------------------------------------------------------------
    # Access
    # ------------------------------------------------------------------
    def _check_user_allowed(self, user):
        """Return a ready-to-show refusal message, or False when allowed.

        One function with three callers: the dashboard (to gray the button out),
        the upload controller (to refuse before reading a large request body)
        and create() (the gate that actually enforces it).
        """
        self.ensure_one()
        if not user.has_group('showroom_check.group_cleaning_user'):
            return self.env._(
                "You do not have the Showroom Check \"User\" role, so you "
                "cannot record cleaning rounds. Ask your system administrator "
                "to give you that role.")
        if self.allowed_user_mode == 'list' and user not in self.allowed_user_ids:
            return self.env._(
                "You are not on the list of users allowed to record cleaning "
                "rounds. Ask a Showroom Check Manager to add you.")
        return False

    # ------------------------------------------------------------------
    # The four originals
    # ------------------------------------------------------------------
    def _ensure_reference_rows(self):
        """Give every config exactly one row per direction. Idempotent.

        The rows are created empty, so the settings form always presents four
        labelled slots waiting for a photograph rather than an empty list with
        an Add button - there are exactly four views and there is never a fifth.
        Safe to call as often as you like; it only ever adds what is missing.
        """
        Reference = self.env['cleaning.reference.image'].sudo()
        for config in self:
            existing = set(config.reference_image_ids.mapped('direction'))
            missing = [key for key in DIRECTION_KEYS if key not in existing]
            if missing:
                Reference.create([{
                    'config_id': config.id,
                    'direction': key,
                    'name': DIRECTION_DEFAULT_LABEL[key],
                    'sequence': DIRECTION_SEQUENCE[key],
                } for key in missing])
        return True

    def _reference_by_direction(self):
        """{direction: reference row} for the rows that have a photograph."""
        self.ensure_one()
        return {
            reference.direction: reference
            for reference in self.reference_image_ids
            if reference.image
        }

    def _askable_directions(self):
        """Which directions may be photographed at all, in order.

        The originals are the specification: a direction with no original has
        nothing to compare a photograph against, so a photograph of it can
        never be scored and is not worth keeping.

        Separate from _required_directions below because "may be sent" and
        "must be sent" are different questions. require_photos answers only the
        second, so deciding what to KEEP by the requirement would throw away
        every photograph in every office that has not switched it on yet -
        which is every office to begin with.
        """
        self.ensure_one()
        return [
            reference.direction
            for reference in self.reference_image_ids.sorted(
                lambda r: (r.sequence, r.id))
            if reference.image
        ]

    def _required_directions(self):
        """Which directions a round has to photograph.

        Exactly the ones that have an original - not "all four" and not "any".

        Requiring a direction with no original would block every round on a
        half-finished setup and give the comparison nothing to compare against.
        Requiring none would let the feature quietly do nothing. So the
        originals are the specification, and because the dashboard payload is
        built from this same method, the client and the server cannot disagree
        about what is being asked for.
        """
        self.ensure_one()
        return self._askable_directions() if self.require_photos else []

    def _direction_payload(self):
        """The ordered directions to photograph, for the client.

        URLs, never bytes. The dashboard re-reads this every sixty seconds, and
        four base64 photographs in it would be several megabytes each time.

        The reference URL carries the row's write date, because an original can
        be replaced - unlike a recording, which is written once and is why the
        video route may declare itself immutable.

        Directions with no original are left out entirely. Such a row has no
        picture to show beside the camera and no way to be scored afterwards,
        so listing it does nothing but invite a client to ask somebody to
        photograph a view the server is going to discard.

        Each row after the first carries the turn from the one before it, so
        the whole shape of the round is decided here: which views, in what
        order, and how far to turn between them. A client is left to draw an
        arrow and count degrees, which is all it should have to know. The first
        row has no 'turn' at all - there is nothing to have turned from - and a
        client must read a missing turn as "none to show" rather than as a
        quarter turn, which is what it would be tempted to assume.
        """
        self.ensure_one()
        rows = []
        previous = None
        for reference in self.reference_image_ids.sorted(
                lambda r: (r.sequence, r.id)):
            if not reference.image:
                continue
            stamp = reference.write_date and int(reference.write_date.timestamp())
            turn = turn_between(previous, reference.direction) if previous else None
            previous = reference.direction
            rows.append({
                'key': reference.direction,
                'label': reference.name or DIRECTION_DEFAULT_LABEL.get(
                    reference.direction, reference.direction),
                'sequence': reference.sequence,
                'instructions': reference.instructions or '',
                # How far to turn to face this view from the last one, and
                # which way. Absent on the first row, deliberately.
                'turn': turn,
                # Always true now that the rest are filtered out. Kept on the
                # wire so a client that tests it carries on working.
                'has_reference': True,
                'reference_id': reference.id,
                'reference_url': (
                    '/web/image/cleaning.reference.image/%s/image?unique=%s'
                    % (reference.id, stamp or 0)),
            })
        return rows

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        configs = super().create(vals_list)
        configs._ensure_reference_rows()
        return configs

    @api.model
    def _get_for_company(self, company=None):
        company = company or self.env.company
        return self.search([('company_id', '=', company.id)], limit=1)

    def action_open_settings(self):
        """Open *the* configuration record rather than a list of one.

        A menu item cannot carry a dynamic res_id in XML, so the menu points at
        a server action that calls this.
        """
        config = self._get_for_company()
        if not config:
            config = self.create({'company_id': self.env.company.id})
            self.env['cleaning.slot'].create([
                dict(vals, config_id=config.id) for vals in DEFAULT_SLOTS
            ])
        # Also covers a config made before the photographs existed.
        config._ensure_reference_rows()
        return {
            'type': 'ir.actions.act_window',
            'name': self.env._('Cleaning Recording Settings'),
            'res_model': 'cleaning.config',
            'res_id': config.id,
            'view_mode': 'form',
            'target': 'current',
        }

    # ------------------------------------------------------------------
    # Dashboard
    # ------------------------------------------------------------------
    def _recording_settings(self):
        """The resolved capture parameters handed to the browser."""
        self.ensure_one()
        preset = QUALITY_PRESETS.get(self.video_quality) or QUALITY_PRESETS['medium']
        preferred = self.video_format or 'webm'
        other = 'mp4' if preferred == 'webm' else 'webm'
        return {
            'duration_seconds': self.duration_seconds,
            'max_duration_seconds': MAX_DURATION_SECONDS,
            'format': preferred,
            # Preferred container first, then the fallback: the client walks
            # this list and takes the first one the browser can actually mux.
            'mimetype_candidates': (
                MIMETYPE_CANDIDATES[preferred] + MIMETYPE_CANDIDATES[other]
            ),
            'quality': self.video_quality,
            'width': preset['width'],
            'height': preset['height'],
            'frame_rate': preset['frame_rate'],
            'video_bitrate': preset['video_bitrate'],
            # Audio is deliberately never recorded: it keeps the files small,
            # avoids a second permission prompt, and avoids capturing private
            # conversations happening in the office.
            'audio_enabled': False,
            'facing_mode': self.camera_facing,
            # One chunk per second. Without this the recorder only hands over
            # data when it stops, so an oversized clip could not be cut short
            # while it was still being recorded.
            'timeslice_ms': 1000,
            'max_upload_bytes': max(1, self.max_upload_mb) * 1024 * 1024,
            # How many stills the browser should grab while recording, for the
            # AI review to look at afterwards. Zero when AI review is switched
            # off, so nothing extra is captured or uploaded for people who do
            # not use it.
            'ai_frames': self._ai_frames_wanted(),
            'estimated_size_mb': round(self.estimated_size_mb, 1),
            'upload_url': '/showroom_check/upload',
            # --- the photographs -------------------------------------
            # video_enabled is read by the client as "not False", so a client
            # talking to an older server that never sent it still records a
            # video, exactly as it always did.
            'video_enabled': self.video_enabled,
            'require_photos': self.require_photos,
            'min_photo_bytes': MIN_PHOTO_BYTES,
            'directions': self._direction_payload(),
            # Both questions answered explicitly. "May I send this?" and "must
            # I send this?" have different answers whenever require_photos is
            # off, and a client left to work the first one out from the second
            # would stop sending photographs the moment it was switched off.
            'askable_directions': self._askable_directions(),
            'required_directions': self._required_directions(),
            'match_warn_threshold': self.match_warn_threshold,
            'match_alert_threshold': self.match_alert_threshold,
        }

    def _ai_frames_wanted(self):
        """Stills to capture per recording, or 0 when none should be.

        Zero when there is no video to pull them out of, as well as when AI
        review is off. Without that check a client would be told to grab three
        stills from a recording it was never asked to make.
        """
        self.ensure_one()
        if not self.video_enabled:
            return 0
        ai_config = self.env['cleaning.ai.config'].sudo()._get_for_company(
            self.company_id)
        if not ai_config or not ai_config.enabled:
            return 0
        return max(1, min(ai_config.frames_per_recording or 3, 10))

    def _slot_rows(self, now_utc=None):
        """Classify every one of today's slots in a single pass.

        Returns ``(rows, active_tuple, now_utc, local_now, today)`` where
        ``active_tuple`` is ``(slot, opens_utc, closes_utc, recording)`` for the
        open slot, or None.
        """
        self.ensure_one()
        now_utc = now_utc or fields.Datetime.now()
        local_now = self._local_now(now_utc)
        today = local_now.date()
        weekday = today.weekday()

        # sudo() is load-bearing. A "User" only sees their own recordings, so
        # without it the dashboard would tell Ravi that Priya's 09:00 round has
        # not been done; he would record it, and the save would fail on a raw
        # database error with no usable message. Whether a clip exists is not
        # confidential - its contents are, and those still go through the
        # record rules.
        recorded = {
            rec.slot_id.id: rec
            for rec in self.env['cleaning.recording'].sudo().search([
                ('config_id', '=', self.id),
                ('slot_date', '=', today),
            ])
        }

        # Who is allowed to actually open a clip, as opposed to merely seeing
        # that the round is done. Read access is limited to your own recordings
        # unless you are a Manager, so offering everybody a Watch button means
        # offering most people an access error.
        is_manager = self.env.user.has_group(
            'showroom_check.group_cleaning_manager')

        rows = []
        active = None
        todays_slots = self.slot_ids.filtered(
            lambda s: s.active and s._runs_on(weekday)
        ).sorted(lambda s: (s.sequence, s.hour_from, s.id))

        for slot in todays_slots:
            opens_utc, closes_utc = slot._window_utc(today)
            recording = recorded.get(slot.id)
            if recording:
                state = 'done'
            elif now_utc < opens_utc:
                state = 'upcoming'
            elif now_utc <= closes_utc:
                state = 'open'
            else:
                state = 'missed'

            rows.append({
                'id': slot.id,
                'name': slot.name,
                'day_period': slot.day_period,
                'window_label': '%s - %s' % (
                    format_float_time(slot.hour_from),
                    format_float_time(slot.hour_to)),
                'hour_from': slot.hour_from,
                'hour_to': slot.hour_to,
                'note': slot.note or '',
                'state': state,
                'seconds_until_open': max(
                    0, int((opens_utc - now_utc).total_seconds())),
                'seconds_until_close': max(
                    0, int((closes_utc - now_utc).total_seconds())),
                'recording_id': recording.id if recording else False,
                'recorded_by': recording.user_id.name if recording else False,
                'recorded_at': (
                    fields.Datetime.to_string(recording.started_at)
                    if recording and recording.started_at else False),
                'can_view': bool(
                    recording
                    and (is_manager or recording.user_id == self.env.user)),
            })
            if state == 'open' and active is None:
                active = (slot, opens_utc, closes_utc, recording)

        return rows, active, now_utc, local_now, today

    @api.model
    def get_dashboard_state(self):
        """Everything the dashboard needs, in one call.

        Called when the page opens, on a poll while it is open, and again right
        after a successful upload.
        """
        config = self._get_for_company()
        if not config:
            return {
                'ok': False,
                'deny_reason': 'no_config',
                'deny_message': self.env._(
                    "Cleaning rounds have not been set up yet. A Cleaning "
                    "Management Manager needs to add the daily time slots "
                    "first."),
                'slots': [],
            }

        rows, active, now_utc, local_now, today = config._slot_rows()
        deny_message = config._check_user_allowed(self.env.user)
        is_manager = self.env.user.has_group(
            'showroom_check.group_cleaning_manager')

        active_payload = False
        if active:
            slot, opens_utc, closes_utc, recording = active
            seconds_remaining = max(0, int((closes_utc - now_utc).total_seconds()))
            if recording:
                block_reason = 'already_recorded'
            elif deny_message:
                block_reason = 'not_allowed'
            else:
                block_reason = False
            active_payload = {
                'id': slot.id,
                'name': slot.name,
                'day_period': slot.day_period,
                'window_label': '%s - %s' % (
                    format_float_time(slot.hour_from),
                    format_float_time(slot.hour_to)),
                'note': slot.note or '',
                'opens_at': fields.Datetime.to_string(opens_utc),
                'closes_at': fields.Datetime.to_string(closes_utc),
                'seconds_remaining': seconds_remaining,
                'already_recorded': bool(recording),
                'recording_id': recording.id if recording else False,
                'can_record': not block_reason,
                'block_reason': block_reason,
                # True when there is not enough of the window left to finish a
                # full recording - the button still works, but the UI warns.
                'will_overrun': seconds_remaining < config.duration_seconds,
            }

        next_row = next(
            (row for row in rows if row['state'] == 'upcoming'), None)

        return {
            'ok': True,
            'config_id': config.id,
            # The browser must never decide on its own that a window has opened
            # - its clock can be minutes out. It uses this to measure the
            # offset, counts down locally, and asks the server again before the
            # button is ever enabled.
            'server_now': fields.Datetime.to_string(now_utc),
            'server_now_ts': now_utc.replace(tzinfo=pytz.utc).timestamp(),
            'timezone': config.timezone,
            'local_now': local_now.strftime('%Y-%m-%d %H:%M:%S'),
            'today': fields.Date.to_string(today),
            'poll_seconds': 60,
            'poll_seconds_near': 15,
            'near_window_seconds': 120,
            'is_allowed': not deny_message,
            'is_manager': is_manager,
            'deny_message': deny_message or False,
            'settings': config._recording_settings(),
            'active_slot': active_payload,
            'next_slot': next_row or False,
            'slots': rows,
            'today_total': len(rows),
            'today_done': len([r for r in rows if r['state'] == 'done']),
            'today_missed': len([r for r in rows if r['state'] == 'missed']),
        }
