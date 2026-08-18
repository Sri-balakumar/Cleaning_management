import logging

from dateutil.relativedelta import relativedelta

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from .cleaning_config import (
    DIRECTION_DEFAULT_LABEL, DIRECTION_SEQUENCE, MATCH_LEVELS, MIN_PHOTO_BYTES,
    format_float_time,
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
                 'shot_ids.name')
    def _compute_match(self):
        for recording in self:
            scored = recording.shot_ids.filtered('matched_at')
            if not scored:
                recording.match_score = 0
                recording.match_score_avg = 0
                recording.match_worst_label = False
                recording.matched_at = False
                continue
            scores = scored.mapped('match_score')
            worst = min(scored, key=lambda shot: shot.match_score)
            recording.match_score = worst.match_score
            recording.match_score_avg = int(round(sum(scores) / float(len(scores))))
            recording.match_worst_label = worst.name
            recording.matched_at = max(scored.mapped('matched_at'))

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
            bands = {
                'ok': [('match_score', '>=', warn), ('matched_at', '!=', False)],
                'warn': [('match_score', '>=', alert), ('match_score', '<', warn),
                         ('matched_at', '!=', False)],
                'alert': [('match_score', '<', alert), ('matched_at', '!=', False)],
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
        # the past as one full recording plus the grace period allows.
        now = fields.Datetime.now()
        oldest_allowed = now - relativedelta(
            seconds=config.duration_seconds + max(0, config.upload_grace_seconds))
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
        """
        self.ensure_one()
        Shot = self.env['cleaning.recording.shot']
        references = self.config_id._reference_by_direction()
        stored = Shot.browse()

        for direction, blob, mimetype, filename in shots:
            if not blob or len(blob) < MIN_PHOTO_BYTES:
                continue
            reference = references.get(direction)
            existing = self.shot_ids.filtered(
                lambda s, d=direction: s.direction == d)
            if existing:
                existing.sudo().unlink()
            shot = Shot.create({
                'recording_id': self.id,
                'direction': direction,
                'name': (reference.name if reference
                         else DIRECTION_DEFAULT_LABEL.get(direction, direction)),
                'sequence': DIRECTION_SEQUENCE.get(direction, 50),
                'reference_image_id': reference.id if reference else False,
                'reference_write_date': reference.write_date if reference else False,
            })
            shot._attach_image(blob, filename, mimetype)
            stored |= shot

        stored._run_match_comparison()
        # The aggregates are stored, and the scores were written with sudo().
        self.invalidate_recordset(['shot_ids'])
        self.modified(['shot_ids'])
        return stored

    def action_recompute_match(self):
        """Re-score the photographs against the originals as they stand now.

        Wanted after the comparison is tuned, or after an original is replaced.
        Cheap, because the originals carry their prepared values already.
        """
        if not self.env.user.has_group(
                'showroom_check.group_cleaning_manager'):
            raise AccessError(self.env._(
                "Only a Showroom Check Manager can re-run a comparison."))
        self.mapped('shot_ids')._run_match_comparison()
        return True

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
