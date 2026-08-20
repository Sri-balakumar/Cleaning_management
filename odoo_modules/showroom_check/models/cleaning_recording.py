import logging

from dateutil.relativedelta import relativedelta

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from . import cleaning_image_compare as compare
from .cleaning_config import (
    DIRECTION_SEQUENCE, MATCH_LEVELS, MIN_PHOTO_BYTES, PHOTO_ROUND_SECONDS,
    VIEW_MISMATCH_DISTANCE, format_float_time,
)

_logger = logging.getLogger(__name__)

# Deleted in batches of this size. Kept small on purpose: each row can be tens
# of megabytes, and each deletion also writes a filestore bookkeeping entry.
GC_BATCH_LIMIT = 100


def base_mimetype(mimetype):
    """Strip any parameters, leaving just ``type/subtype``.

    Browsers hand back things like ``video/mp4;codecs=avc1.42e01e``. That is a
    perfectly good description of the file, but a poor Content-Type header:
    Odoo serves attachments with ``X-Content-Type-Options: nosniff``, so the
    browser must trust the header exactly and is not allowed to fall back to
    examining the file. A codecs parameter is enough for it to decline to show
    a video player.
    """
    return (mimetype or '').split(';')[0].strip() or 'video/webm'


class CleaningRecording(models.Model):
    _name = 'cleaning.recording'
    _description = 'Cleaning Recording'
    _order = 'slot_date desc, slot_id, id desc'

    # There is deliberately no `active` field. Archiving would keep the row,
    # which means the one-per-day constraint would still block a replacement
    # *and* the video would still be occupying disk. "A Manager deletes the
    # recording to re-open the slot" only works with a real deletion.

    slot_id = fields.Many2one(
        'cleaning.slot', string='Slot', required=True,
        index=True, ondelete='restrict')
    config_id = fields.Many2one(
        related='slot_id.config_id', store=True, index=True, readonly=True)
    company_id = fields.Many2one(
        related='slot_id.company_id', store=True, index=True, readonly=True)
    slot_date = fields.Date(
        string='Date', required=True, index=True,
        help="The calendar date in the office timezone - not the UTC date. A "
             "23:30 round in India happens on the previous UTC day, and using "
             "the UTC date there would split one evening across two dates.")
    user_id = fields.Many2one(
        'res.users', string='Recorded By', required=True, index=True,
        default=lambda self: self.env.user, ondelete='restrict')

    # --- The video --------------------------------------------------------
    video_file = fields.Binary(
        string='Recording', attachment=True,
        help="Held in the server file store rather than in the database itself.")
    video_filename = fields.Char(string='File Name')
    mimetype = fields.Char(
        string='MIME Type', readonly=True,
        help="Exactly what the browser produced, kept verbatim so playback "
             "works.")
    file_format = fields.Selection(
        [('webm', 'WebM'), ('mp4', 'MP4'), ('other', 'Other')],
        string='Format', readonly=True, default='webm')
    quality = fields.Selection(
        [('low', 'Low'), ('medium', 'Medium'), ('high', 'High')],
        string='Quality', readonly=True)
    file_size = fields.Integer(
        string='Size (bytes)', readonly=True, aggregator='sum',
        help="Stored directly on the recording. Reading it back off the video "
             "itself would need a separate lookup for every row, which makes "
             "the list view crawl.")
    file_size_mb = fields.Float(
        string='Size (MB)', compute='_compute_file_size_mb',
        digits=(10, 2), aggregator='sum', store=True)
    width = fields.Integer(string='Width', readonly=True)
    height = fields.Integer(string='Height', readonly=True)
    truncated = fields.Boolean(
        string='Cut Short', readonly=True,
        help="Set when the recording had to stop early because it reached the "
             "maximum file size before the configured duration was up.")

    # --- Timing -----------------------------------------------------------
    started_at = fields.Datetime(
        string='Started At', required=True, readonly=True,
        help="When recording began. This is the time checked against the "
             "slot's window.")
    ended_at = fields.Datetime(string='Ended At', readonly=True)
    uploaded_at = fields.Datetime(
        string='Uploaded At', readonly=True, default=fields.Datetime.now)
    duration_seconds = fields.Integer(
        string='Actual Duration (seconds)', readonly=True)
    configured_duration_seconds = fields.Integer(
        string='Configured Duration (seconds)', readonly=True,
        help="What the duration setting was at the time. Kept so that changing "
             "the setting later does not appear to rewrite history.")

    # --- Audit ------------------------------------------------------------
    capture_mode = fields.Selection(
        [('browser', 'Browser Webcam'), ('mobile', 'Mobile App'),
         ('manual', 'Manual Upload')],
        string='Mode', readonly=True, default='browser')
    capture_kind = fields.Selection(
        [('video', 'Video'), ('photographs', 'Photographs')],
        string='Recorded As', readonly=True,
        help="Which way this round was captured. A video round is scored on "
             "stills read back out of the recording; a photographs round is "
             "scored on the pictures somebody took of each view.\n\n"
             "Empty on every round recorded before there was a choice, which "
             "is not the same as either answer and must not be shown as one.")
    ip_address = fields.Char(string='IP Address', readonly=True)
    browser = fields.Char(string='Browser', readonly=True)
    user_agent = fields.Char(string='User Agent', readonly=True)
    latitude = fields.Float(
        string='Latitude', digits=(10, 7), readonly=True, aggregator=None)
    longitude = fields.Float(
        string='Longitude', digits=(10, 7), readonly=True, aggregator=None)
    location = fields.Char(
        string='Location', readonly=True,
        help="From the browser's location service if it was allowed, "
             "otherwise worked out from the IP address.")
    note = fields.Text(string='Notes')

    # --- the four photographs, and what they came to -----------------------
    shot_ids = fields.One2many(
        'cleaning.recording.shot', 'recording_id', string='Photographs',
        readonly=True)
    shot_count = fields.Integer(
        string='Photographs', compute='_compute_shot_stats', store=True)
    shot_size = fields.Integer(
        string='Photograph Bytes', compute='_compute_shot_stats', store=True,
        aggregator='sum',
        help="Technical: lets the clean-up find photograph-only rounds without "
             "reaching through to the stored files.")

    match_score = fields.Integer(
        string='Match (arrangement)', compute='_compute_match', store=True,
        aggregator='avg',
        help="The WORST of the four views, not the average.\n\n"
             "The point of this number is to notice a problem. Scores of 85, "
             "88, 30 and 90 average out to 73 and sail past any sensible "
             "warning level - and the 30 is the entire reason anybody is "
             "looking.")
    match_score_avg = fields.Integer(
        string='Average Match', compute='_compute_match', store=True,
        aggregator='avg',
        help="The mean across the views. Too smooth to warn on, but the right "
             "number to watch over weeks.")
    match_worst_label = fields.Char(
        string='Worst View', compute='_compute_match', store=True)
    match_level = fields.Selection(
        MATCH_LEVELS, string='Verdict', compute='_compute_match_level',
        search='_search_match_level')
    matched_at = fields.Datetime(
        string='Compared At', compute='_compute_match', store=True)

    # Drives read-only state in the form. A view cannot test group membership
    # inside a readonly= expression, so the check is exposed as a field.
    can_manage = fields.Boolean(
        string='Can Manage', compute='_compute_can_manage',
        help='Technical: true for Cleaning Managers, who may edit a recording. '
             'Everyone else reads it only.')

    _uniq_slot_day = models.Constraint(
        'UNIQUE (slot_id, slot_date)',
        'This cleaning round has already been recorded for that day. A Manager '
        'has to delete the existing recording before it can be recorded again.',
    )
    _check_file_size = models.Constraint(
        'CHECK (file_size >= 0)',
        'File size cannot be negative.',
    )
    _check_duration_seconds = models.Constraint(
        'CHECK (duration_seconds >= 0)',
        'Duration cannot be negative.',
    )

    # ------------------------------------------------------------------
    # Computes
    # ------------------------------------------------------------------
    # Depends on the user, not on any stored column. Without the context
    # dependency the value is cached per record and shared between users in
    # the same worker, so a Manager's True leaks into a User's form.
    @api.depends_context('uid')
    def _compute_can_manage(self):
        is_manager = self.env.user.has_group(
            'showroom_check.group_cleaning_manager')
        for recording in self:
            recording.can_manage = is_manager

    @api.depends('shot_ids', 'shot_ids.file_size')
    def _compute_shot_stats(self):
        for recording in self:
            recording.shot_count = len(recording.shot_ids)
            recording.shot_size = sum(recording.shot_ids.mapped('file_size'))

    @api.depends('shot_ids.match_score', 'shot_ids.matched_at',
                 'shot_ids.score_approximate', 'shot_ids.name')
    def _compute_match(self):
        """The round's figure, from the views that were actually measured.

        Approximate scores are left out on purpose. They are real numbers
        about pixels that do not correspond, and the round takes its score
        from the WORST view - so a single unlined-up photograph would drag
        the whole round to zero and raise a red ribbon over a room nobody
        has any evidence about.

        A round where nothing could be lined up therefore reads as not
        compared, which is the truth about it.
        """
        for recording in self:
            # Compared At comes from every photograph that was looked at,
            # including the ones that could not be lined up. It answers
            # "when did this last run", and leaving it blank on a round
            # compared a minute ago reads as a feature that never fired.
            attempted = recording.shot_ids.filtered("matched_at")
            recording.matched_at = (
                max(attempted.mapped("matched_at")) if attempted else False)

            scored = attempted.filtered(
                lambda shot: not shot.score_approximate)
            if not scored:
                recording.match_score = 0
                recording.match_score_avg = 0
                recording.match_worst_label = False
                continue
            scores = scored.mapped('match_score')
            worst = min(scored, key=lambda shot: shot.match_score)
            recording.match_score = worst.match_score
            recording.match_score_avg = int(round(sum(scores) / float(len(scores))))
            recording.match_worst_label = worst.name

    @api.depends('match_score', 'matched_at',
                 'config_id.match_warn_threshold',
                 'config_id.match_alert_threshold')
    def _compute_match_level(self):
        """The band, not the number - see cleaning.recording.shot for why this
        is not stored."""
        for recording in self:
            config = recording.config_id
            warn = config.match_warn_threshold or 60
            alert = config.match_alert_threshold or 50
            if not recording.matched_at:
                recording.match_level = 'unknown'
            elif not recording.match_worst_label:
                # Looked at, and not one view could be lined up. match_score is
                # 0 here because there was nothing to average, and banding that
                # as alert would put a red ribbon over a round nobody has any
                # evidence about.
                recording.match_level = 'unaligned'
            elif recording.match_score < alert:
                recording.match_level = 'alert'
            elif recording.match_score < warn:
                recording.match_level = 'warn'
            else:
                recording.match_level = 'ok'

    def _search_match_level(self, operator, value):
        """Let the bands be filtered on even though they are not stored.

        A manager filters far more often than they group, so translating a band
        back into a range of scores buys back the useful half of what leaving
        the field unstored costs.
        """
        if operator not in ('=', '!=', 'in', 'not in'):
            raise NotImplementedError(self.env._(
                "A verdict can only be filtered with = or in."))
        wanted = value if isinstance(value, (list, tuple)) else [value]
        if operator in ('!=', 'not in'):
            wanted = [key for key, _label in MATCH_LEVELS if key not in wanted]

        # Thresholds are per company, so each config contributes its own range.
        clauses = []
        for config in self.env['cleaning.config'].sudo().search([]):
            warn = config.match_warn_threshold or 60
            alert = config.match_alert_threshold or 50
            # match_worst_label is only set where at least one view was
            # actually measured, so it is the stored stand-in for 'this round
            # has a real score' - and its absence is the unaligned band.
            bands = {
                'ok': [('match_score', '>=', warn), ('matched_at', '!=', False),
                       ('match_worst_label', '!=', False)],
                'warn': [('match_score', '>=', alert), ('match_score', '<', warn),
                         ('matched_at', '!=', False),
                         ('match_worst_label', '!=', False)],
                'alert': [('match_score', '<', alert), ('matched_at', '!=', False),
                          ('match_worst_label', '!=', False)],
                'unaligned': [('matched_at', '!=', False),
                              ('match_worst_label', '=', False)],
                'unknown': [('matched_at', '=', False)],
            }
            for band in wanted:
                if band not in bands:
                    continue
                clauses.append(
                    [('config_id', '=', config.id)] + bands[band])
        if not clauses:
            return [('id', '=', False)]

        domain = clauses[0]
        for clause in clauses[1:]:
            domain = ['|'] + domain + clause
        return domain

    @api.depends('file_size')
    def _compute_file_size_mb(self):
        for rec in self:
            rec.file_size_mb = (rec.file_size or 0) / (1024.0 * 1024.0)

    @api.depends('slot_id.name', 'slot_date', 'user_id.name')
    def _compute_display_name(self):
        for rec in self:
            rec.display_name = '%s - %s (%s)' % (
                rec.slot_id.name or '?',
                fields.Date.to_string(rec.slot_date) or '?',
                rec.user_id.name or '?',
            )

    # ------------------------------------------------------------------
    # Creation gate
    # ------------------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            self._validate_capture(vals)
        return super().create(vals_list)

    def _validate_capture(self, vals):
        """The real gate.

        Graying out the dashboard button is a courtesy to the user; this is what
        actually makes the rules true. It lives here rather than in the
        controller so that the web page, an integration over XML-RPC and
        anything else all go through the same checks.
        """
        if self.env.su:
            # Automated cleanup, data files and tests.
            return

        slot = self.env['cleaning.slot'].sudo().browse(vals.get('slot_id'))
        if not slot.exists() or not slot.active:
            raise ValidationError(self.env._(
                "This cleaning round no longer exists. Reload the page and try "
                "again."))
        config = slot.config_id

        refusal = config._check_user_allowed(self.env.user)
        if refusal:
            raise AccessError(refusal)

        if self.env.user.has_group('showroom_check.group_cleaning_manager'):
            # A Manager may add a recording outside a window - for example to
            # attach footage that was captured on a phone. The one-per-day rule
            # still applies to them.
            return

        started_at = fields.Datetime.to_datetime(vals.get('started_at'))
        if not started_at:
            raise ValidationError(self.env._(
                "The recording is missing its start time and cannot be saved."))

        local_date = config._local_date(started_at)
        if not slot._runs_on(local_date.weekday()):
            raise ValidationError(self.env._(
                "\"%(slot)s\" does not run on %(day)s.",
                slot=slot.name, day=local_date.strftime('%A')))

        opens, closes = slot._window_utc(local_date)
        if not (opens <= started_at <= closes):
            raise ValidationError(self.env._(
                "The \"%(slot)s\" window (%(window)s, %(tz)s) was not open when "
                "this recording started.",
                slot=slot.name,
                window='%s - %s' % (format_float_time(slot.hour_from),
                                    format_float_time(slot.hour_to)),
                tz=config.timezone))

        # The date the client claims must be the one its own start time implies.
        # Without this check a recording could be started inside yesterday's
        # window but filed under today, side-stepping the one-per-day rule
        # entirely.
        claimed_date = fields.Date.to_date(vals.get('slot_date'))
        if claimed_date != local_date:
            raise ValidationError(self.env._(
                "The recording's date does not match the time it was started. "
                "Reload the page and record again."))

        # And it must not be back-dated: the start time may only be as far in
        # the past as the round itself plus the grace period allows.
        #
        # With the video off there is no duration to allow for - duration_seconds
        # describes a clip and is zero - so the walk is what has to be allowed
        # instead. Left as it was, a photographs-only round timed from its first
        # photograph was refused as back-dated the moment somebody took more than
        # the grace period to walk the room, which is most of them.
        now = fields.Datetime.now()
        # Timed by what was actually done, not by what the settings permit.
        # Where somebody CHOSE to photograph a round on a site that also allows
        # video, the round took as long as walking the room takes, and timing
        # it by the clip's duration instead refused it as back-dated the moment
        # the walk ran over - which is the same failure the photographs-only
        # case above was fixed for. An upload that says nothing about how it
        # was captured falls back to the setting, exactly as before.
        records_video = (config.video_enabled
                         if not vals.get('capture_kind')
                         else vals.get('capture_kind') == 'video')
        round_seconds = (config.duration_seconds if records_video
                         else PHOTO_ROUND_SECONDS)
        oldest_allowed = now - relativedelta(
            seconds=round_seconds + max(0, config.upload_grace_seconds))
        if started_at < oldest_allowed or started_at > now + relativedelta(minutes=5):
            raise ValidationError(self.env._(
                "This recording's start time is not close enough to the "
                "current time to be accepted. Check that the clock on this "
                "computer is correct, then record again."))

    def unlink(self):
        for rec in self:
            _logger.info(
                "cleaning.recording %s (%s on %s, recorded by %s) deleted by %s",
                rec.id, rec.slot_id.name, rec.slot_date,
                rec.user_id.login, self.env.user.login)
        return super().unlink()

    # ------------------------------------------------------------------
    # Storing the video
    # ------------------------------------------------------------------
    def _attach_video(self, blob, filename, mimetype):
        """Store the clip the same way the Binary field would have, from bytes.

        The Binary field itself expects base64, which for a 90 MB clip means
        building a 120 MB string in memory for no reason. Creating the
        attachment directly with the same res_model / res_field / res_id
        produces exactly the same result - the field still reads it back,
        clearing the field still deletes it, and access to it still follows this
        record's own permissions.
        """
        self.ensure_one()
        full_mimetype = mimetype or 'video/webm'
        attachment = self.env['ir.attachment'].sudo().create({
            'name': filename,
            'res_model': self._name,
            'res_field': 'video_file',
            'res_id': self.id,
            'type': 'binary',
            'raw': blob,
            # The BASE type only. Whatever goes here is sent verbatim as the
            # Content-Type header, and Odoo sends X-Content-Type-Options:
            # nosniff with it - so the browser has to take the header at face
            # value and may not inspect the file to work out what it is. A
            # browser-supplied type like "video/mp4;codecs=avc1.42e01e" is
            # enough for it to refuse to show a player. The codecs parameter
            # adds nothing for playback.
            'mimetype': base_mimetype(full_mimetype),
        })
        self.sudo().write({
            'video_filename': filename,
            'file_size': attachment.file_size,
            # The recording keeps the full string. It never becomes a header,
            # and it is worth having an exact record of what the browser
            # produced when diagnosing a playback problem later.
            'mimetype': full_mimetype,
        })
        self.invalidate_recordset(['video_file'])
        return attachment

    # ------------------------------------------------------------------
    # Retention
    # ------------------------------------------------------------------
    @api.autovacuum
    def _store_direction_shots(self, shots):
        """Save this round's photographs and score them.

        `shots` is a list of ``(direction, blob, mimetype, filename)``. Sending
        the same direction twice replaces the earlier one, so a retried upload
        can never leave two 'front' photographs behind.

        Deliberately NOT a reuse of _store_frames. Those are stills cut out of
        the video: ordered by time, interchangeable, and meaningless one at a
        time. These are ordered by place, each is matched to one specific
        original, and each carries its own verdict. One method serving both
        would be a list whose positional meaning changes with the caller, which
        is precisely the shape of the frame_10 sorting bug.

        A direction with no original is skipped rather than stored unscored.
        The upload route already drops those and tells the sender so, and this
        is the same rule stated where it cannot be got round: a shot records
        WHICH original it was taken against, so one created without an original
        can never be scored - not now, and not by action_recompute_match after
        somebody adds the missing original next month.
        """
        self.ensure_one()
        Shot = self.env['cleaning.recording.shot']
        references = self.config_id._reference_by_direction()
        stored = Shot.browse()

        for direction, blob, mimetype, filename in shots:
            if not blob or len(blob) < MIN_PHOTO_BYTES:
                continue
            reference = references.get(direction)
            if not reference:
                continue
            existing = self.shot_ids.filtered(
                lambda s, d=direction: s.direction == d)
            if existing:
                existing.sudo().unlink()
            shot = Shot.create({
                'recording_id': self.id,
                'direction': direction,
                'name': reference.name,
                'sequence': DIRECTION_SEQUENCE.get(direction, 50),
                'reference_image_id': reference.id,
                'reference_write_date': reference.image_write_date,
            })
            shot._attach_image(blob, filename, mimetype)
            stored |= shot

        stored._run_match_comparison()
        # The aggregates are stored, and the scores were written with sudo().
        self.invalidate_recordset(['shot_ids'])
        self.modified(['shot_ids'])
        return stored

    # ------------------------------------------------------------------
    # Reading the views out of the recording
    # ------------------------------------------------------------------
    def _video_raw(self):
        """The stored clip's bytes, without going through base64.

        The same trick `_raw_image` uses on a photograph, and for a stronger
        reason: the Binary field hands back base64, which for a ninety megabyte
        clip means building a hundred and twenty megabyte string in order to
        throw it away a moment later.
        """
        self.ensure_one()
        attachment = self.env['ir.attachment'].sudo().search([
            ('res_model', '=', self._name),
            ('res_field', '=', 'video_file'),
            ('res_id', '=', self.id),
        ], limit=1)
        return attachment.raw if attachment else None

    def _frame_shows_view(self, result):
        """Is this frame of the view it was compared against at all?

        Feature matching answers it properly where OpenCV could run, and its
        answer wins: it compares what is IN the two pictures, where the hash
        only compares their overall shape. Without it the hash is all there is
        - the same fallback `_compute_view_mismatch` already makes about a
        photograph.

        Deliberately stricter than the photograph path, which records a
        mismatched picture and flags it. A photograph of the wrong wall is
        somebody's mistake and worth showing them; a frame of the wrong wall is
        just a frame, and there are twenty-three others to choose from.
        """
        if not result or result.get('score') is None:
            return False
        if result.get('same_view') is not None:
            return bool(result['same_view'])
        distance = result.get('hash_distance')
        return distance is not None and distance < VIEW_MISMATCH_DISTANCE

    def _record_unseen_views(self, references, reason):
        """Record that a view has no picture from this round, and why.

        A row rather than a gap. The Comparisons list is read by counting
        cards, so a view the sweep missed simply not being there reads as a
        round nobody finished - where an unscored row carrying a sentence reads
        as what it actually is. The same choice `match_error` already makes for
        a photograph that could not be compared.

        Never replaces a row that is already there: a view somebody
        photographed by hand is not missing, whatever the sweep did.
        """
        self.ensure_one()
        Shot = self.env['cleaning.recording.shot']
        for direction, reference in references.items():
            if self.shot_ids.filtered(lambda s, d=direction: s.direction == d):
                continue
            Shot.sudo().create({
                'recording_id': self.id,
                'direction': direction,
                'name': reference.name,
                'sequence': DIRECTION_SEQUENCE.get(direction, 50),
                'reference_image_id': reference.id,
                'reference_write_date': reference.image_write_date,
                'from_video': True,
                'match_error': reason,
                'matched_at': False,
            })
        self.invalidate_recordset(['shot_ids'])
        self.modified(['shot_ids'])

    def _extract_shots_from_video(self):
        """Fill this round's views from its own recording.

        One sweep of a room passes every wall in it, so the pictures are
        already there - they have simply never been looked at. This reads them
        back out, decides which frame shows which view, and stores the winner
        as this round's photograph of that view, scored by exactly the
        comparison that scores a photograph somebody took by hand. That is the
        point: a round captured either way ends up as the same rows carrying
        the same numbers, so nothing downstream has to know which it was.

        Never raises. It runs inside an upload, and a recording that will not
        decode is something to report on the round rather than a reason to lose
        the round that carried it.

        Returns the shots it stored.
        """
        self.ensure_one()
        Shot = self.env['cleaning.recording.shot']
        references = self.config_id._reference_by_direction()
        if not references:
            return Shot.browse()

        frames = compare.video_frames(self._video_raw())
        if not frames:
            self._record_unseen_views(references, self.env._(
                "This round's recording could not be read, so the views were "
                "never checked against it."))
            return Shot.browse()

        # Once for the whole clip, not once per view. Four views over
        # twenty-four frames used to mean ninety-six hashes, each decoding a
        # JPEG that had just been encoded.
        hashes = compare.frame_hashes(frames)

        chosen = []
        unseen = {}
        # A frame shows one wall, so it can stand for one view. Walked in the
        # order somebody turning on the spot meets them, so where two views
        # want the same frame it goes to the one that comes first in the sweep
        # and the other looks further down its own shortlist.
        taken = set()
        ordered = sorted(references.items(),
                         key=lambda pair: DIRECTION_SEQUENCE.get(pair[0], 50))
        for direction, reference in ordered:
            # An original nobody has prepared yet cannot be matched against.
            # Skipped rather than reported as unseen: the fault is in the
            # setup, not in the sweep, and saying "the recording never showed
            # this view" about it would send somebody to look for the wrong
            # problem.
            if not reference.signature:
                continue
            index, result = compare.best_frame(
                reference.signature, reference._phash_int(), frames,
                reference.features, reference.signature_padded,
                hashes=hashes, skip=taken)
            if index is None or not self._frame_shows_view(result):
                unseen[direction] = reference
                continue
            taken.add(index)
            chosen.append((
                direction, frames[index], 'image/jpeg',
                '%s_%s_%s.jpg' % (direction, self.slot_date, self.user_id.id),
            ))

        stored = self._store_direction_shots(chosen)
        if stored:
            # After storing, not as part of the create: _store_direction_shots
            # is the photograph path too, and teaching it about video would put
            # a flag in it that is False for every one of its other callers.
            stored.sudo().write({'from_video': True})
        if unseen:
            self._record_unseen_views(unseen, self.env._(
                "This round's recording never showed this view."))

        # The stills the AI review reads. Real ones from across the sweep now,
        # rather than the single frame the app grabs after recording stops.
        # Only as many as the review was configured to want: twenty-four
        # attachments per round is a lot of disk for pictures nothing reads.
        wanted = self.config_id._ai_frames_wanted()
        if wanted and not self._frame_attachments():
            step = max(1, len(frames) // wanted)
            self._store_frames([(blob, 'image/jpeg')
                                for blob in frames[::step][:wanted]])
        return stored

    def action_extract_from_video(self):
        """Read the views out of this round's recording. Manager button.

        Wanted after an original is replaced, and - while the app is still
        being taught about the choice - the only way to exercise the whole
        video path at all: record from the browser, press this, read the
        scores.

        Reports rather than raises. A UserError would roll the transaction
        back, and the rows saying which views the sweep missed are exactly the
        thing worth keeping when the answer is disappointing.
        """
        self.ensure_one()
        if not self.env.user.has_group(
                'showroom_check.group_cleaning_manager'):
            raise AccessError(self.env._(
                "Only a Showroom Check Manager can read a round out of its "
                "recording."))
        if not self.video_file:
            raise UserError(self.env._(
                "This round has no recording to read the views out of."))

        stored = self._extract_shots_from_video()
        if stored:
            message = self.env._(
                "%(count)s view(s) were read out of the recording and scored.",
                count=len(stored))
        else:
            message = self.env._(
                "No view could be matched to this recording.\n\n"
                "Either the recording could not be read - which needs OpenCV "
                "installed on this server - or the sweep never showed a view "
                "that has an original set.")
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'type': 'success' if stored else 'warning',
                'message': message,
                'sticky': False,
                'next': {'type': 'ir.actions.act_window_close'},
            },
        }

    def _recompute_and_summarise(self):
        """Re-score, and say what moved since the last time.

        Returns the FACTS - which views moved, from what to what - and no
        sentences at all. The web builds its prose from these in the server
        language; the app builds its own from the same rows in the language
        the phone is set to.

        That split is not fussiness. The app already translates every verdict
        itself rather than reading labels off the server, because a server
        label answers in the language of the Odoo account and not the one the
        person chose in the app. A sentence built here would arrive in the
        wrong language on half the phones that asked for it.

        Against the PREVIOUS RESULT, not against nothing. The question a
        person is asking when they press the button is whether what they just
        did made a difference - replacing an original, moving a threshold -
        and that can only be answered by remembering what it said before.
        """
        shots = self.mapped('shot_ids')
        levels = dict(shots._fields['match_level'].selection)

        def snapshot():
            return {
                shot.id: (shot.match_level, shot.match_score, shot.similarity,
                          shot.registered, shot.match_error or False)
                for shot in shots
            }

        before = snapshot()
        shots._run_match_comparison()
        # match_level and the advisories are computed and unstored, so without
        # this the "after" read hands back the cached "before" and every run
        # reports that nothing changed.
        shots.invalidate_recordset()
        after = snapshot()

        moved = []
        unchanged = 0
        for shot in shots:
            was, now = before.get(shot.id), after.get(shot.id)
            if was == now:
                unchanged += 1
                continue
            was_level, was_score, was_similar, was_reg, _was_err = was
            now_level, now_score, now_similar, now_reg, _now_err = now
            moved.append({
                'name': shot.name or shot.direction,
                'was_level': was_level,
                'now_level': now_level,
                # False, not 0, where there was no score on that side - the
                # difference between "it scored nothing" and "it was never
                # measured" is the whole reason the score is hidden at all.
                'was_score': was_score if was_reg else False,
                'now_score': now_score if now_reg else False,
                'was_similar': was_similar,
                'now_similar': now_similar,
            })

        return {
            'changed': bool(moved),
            'views': moved,
            'unchanged': unchanged,
            # Only the web uses these; the app has its own dictionary.
            'labels': levels,
        }

    def recompute_match_summary(self):
        """The same work as the button, answered as data rather than a dialog.

        For the app, which cannot open an ir.actions.act_window and would not
        want the server language if it could. Public because call_kw refuses
        anything beginning with an underscore.
        """
        self.ensure_one()
        if not self.env.user.has_group(
                'showroom_check.group_cleaning_manager'):
            raise AccessError(self.env._(
                "Only a Showroom Check Manager can re-run a comparison."))
        result = self._recompute_and_summarise()
        # The labels are the server language, so they are no use to a phone
        # that asked for another one. It has its own.
        result.pop('labels', None)
        return result

    def action_recompute_match(self):
        """Re-score the photographs against the originals as they stand now.

        Wanted after the comparison is tuned, or after an original is replaced.
        Cheap, because the originals carry their prepared values already.

        Answers in a dialog rather than silently. It used to return True, so a
        press that changed every verdict and a press that changed nothing were
        indistinguishable - which read as a button that did not work.
        """
        if not self.env.user.has_group(
                'showroom_check.group_cleaning_manager'):
            raise AccessError(self.env._(
                "Only a Showroom Check Manager can re-run a comparison."))

        result = self._recompute_and_summarise()

        if not result['changed']:
            summary = self.env._(
                "Nothing changed. Every view scored exactly as it did "
                "before.\n\n"
                "The photographs of a round cannot change once they are "
                "taken, so only a replaced original or a moved threshold "
                "will move these numbers.")
        else:
            labels = result['labels']
            lines = []
            for view in result['views']:
                parts = ["%s: %s -> %s" % (
                    view["name"],
                    labels.get(view["was_level"], view["was_level"]),
                    labels.get(view["now_level"], view["now_level"]))]
                if view["was_score"] is not False or view["now_score"] is not False:
                    parts.append("Match %s -> %s" % (
                        ("%d%%" % view["was_score"]) if view["was_score"] is not False
                        else self.env._("none"),
                        ("%d%%" % view["now_score"]) if view["now_score"] is not False
                        else self.env._("none")))
                if view["was_similar"] != view["now_similar"]:
                    parts.append("Similar %d%% -> %d%%" % (
                        view["was_similar"], view["now_similar"]))
                lines.append("  \u00b7  ".join(parts))
            summary = "\n".join(lines)
            if result['unchanged']:
                summary += self.env._(
                    "\n\nThe other %s views are unchanged.",
                ) % result['unchanged']

        wizard = self.env['cleaning.compare.result'].create({
            'recording_id': self.id,
            'changed': result['changed'],
            'summary': summary,
        })
        return {
            'type': 'ir.actions.act_window',
            'name': self.env._('Compared Again'),
            'res_model': 'cleaning.compare.result',
            'res_id': wizard.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def _gc_recordings(self):
        """Apply each company's retention setting.

        Returning ``(done, remaining)`` makes Odoo run this again while there is
        still a backlog, so five thousand old clips drain a hundred at a time.
        Deleting them in one go would exceed the server's request time limit and
        be rolled back - deleting nothing at all, every time, forever.
        """
        total = 0
        more_to_do = False

        for config in self.env['cleaning.config'].sudo().search([]):
            if config.retention_number <= 0:
                continue  # 0 means keep forever

            unit = config.retention_unit or 'days'
            cutoff = config._local_date() - relativedelta(
                **{unit: config.retention_number})

            domain = [
                ('config_id', '=', config.id),
                ('slot_date', '<', cutoff),
            ]
            if config.retention_mode == 'purge_video':
                # Without this the same rows are found again on every pass and
                # the cleanup never finishes. `!= False` is the only test that
                # works on a stored file field.
                #
                # The photographs have to be part of the test as well as part
                # of the purge. A photographs-only round has no video at all,
                # so a video-only condition would never match it and its
                # pictures would be kept for ever - the retention setting
                # silently doing nothing for exactly the rounds that carry the
                # most files. shot_size is a plain stored integer, so this stays
                # an index lookup rather than a reach into the filestore.
                domain += ['|', ('video_file', '!=', False),
                           ('shot_size', '>', 0)]

            batch = self.sudo().search(
                domain, order='slot_date, id', limit=GC_BATCH_LIMIT)
            if not batch:
                continue

            count = len(batch)
            if config.retention_mode == 'delete':
                batch.unlink()
            else:
                # Clearing the file field deletes the stored video but keeps the
                # log entry, which is the part worth having later.
                batch.write({'video_file': False, 'file_size': 0})
                # Same treatment for the photographs, and for the same reason:
                # the pictures go, the rows stay. What survives is the score,
                # the verdict and what the AI said changed - which is the part
                # somebody looks back at months later, and it costs nothing to
                # keep.
                batch.shot_ids.write({'image': False, 'file_size': 0})

            total += count
            more_to_do = more_to_do or (count == GC_BATCH_LIMIT)

        if total:
            _logger.info(
                "cleaning.recording retention: processed %s recording(s)", total)
        return total, more_to_do

    @api.autovacuum
    def _gc_orphan_attachments(self):
        """Remove videos whose recording no longer exists.

        Should never happen, but a crash between saving the recording and
        attaching the video would leave a file of tens of megabytes with nothing
        pointing at it.
        """
        Attachment = self.env['ir.attachment'].sudo()
        Shot = self.env['cleaning.recording.shot'].sudo()
        count = 0

        # Two sweeps, one per owning model. The photographs hang off the shot
        # rows rather than off the recording, so a single search would never
        # find them.
        for model, field, owner in (
                (self._name, 'video_file', self.sudo()),
                (Shot._name, 'image', Shot)):
            candidates = Attachment.search([
                ('res_model', '=', model),
                ('res_field', '=', field),
            ], limit=GC_BATCH_LIMIT * 5)
            if not candidates:
                continue
            live_ids = set(owner.browse(candidates.mapped('res_id')).exists().ids)
            orphans = candidates.filtered(lambda a: a.res_id not in live_ids)
            if orphans:
                _logger.info(
                    "%s: removing %s orphaned %s attachment(s)",
                    model, len(orphans), field)
                count += len(orphans)
                orphans.unlink()
        return count, False

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def action_play(self):
        self.ensure_one()
        if not self.video_file:
            # Reachable now that a round can be photographs only, and that the
            # retention setting can drop the video while keeping the round.
            raise UserError(self.env._(
                "There is no video on this round.\n\n"
                "Either it was a photographs-only round, or the video has "
                "already been removed by the retention setting under "
                "Configuration > Settings."))
        return {
            'type': 'ir.actions.act_url',
            'url': '/showroom_check/video/%s' % self.id,
            'target': 'new',
        }
