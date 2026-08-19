import logging

from odoo import api, fields, models
from odoo.tools.image import image_process

from . import cleaning_image_compare as compare
from .cleaning_config import (
    DIRECTIONS, MATCH_LEVELS, STORED_LONG_EDGE, STORED_QUALITY,
)

_logger = logging.getLogger(__name__)


class CleaningRecordingShot(models.Model):
    """One photograph from one round, and the verdict on it.

    The photograph and its result live on the same row on purpose. A direction
    is not a checklist point: it has no check to point at, its verdict reads
    same/changed/unclear rather than yes/no, it carries a score that the
    checklist results have no field for, it carries a second score that has
    nothing to do with the AI at all, and it has to be shown beside two
    pictures. Splitting the result onto its own model would give a row that is
    one-to-one with this one forever.

    Stored as a Binary on THIS model rather than as an attachment on the
    recording, which is what keeps these clear of the video stills: those are
    found by looking for attachments whose res_model is cleaning.recording, and
    these have a res_model of their own. The separation is structural, so
    nobody can break it later by renaming a file.
    """
    _name = 'cleaning.recording.shot'
    _description = 'Showroom Round Photograph'
    _order = 'sequence, id'

    recording_id = fields.Many2one(
        'cleaning.recording', string='Round', required=True,
        index=True, ondelete='cascade')
    company_id = fields.Many2one(
        related='recording_id.company_id', store=True, index=True, readonly=True)
    # Stored and indexed for the same reason company_id above is: the
    # Comparisons view orders and groups by it, and unstored every one of those
    # queries would have to reach through to the recording to sort.
    slot_date = fields.Date(
        related='recording_id.slot_date', string='Date',
        store=True, index=True, readonly=True)

    direction = fields.Selection(
        DIRECTIONS, string='Direction', required=True, index=True, readonly=True)
    name = fields.Char(
        string='What This Shows', required=True,
        help="Copied from the original at the moment the photograph was taken, "
             "so renaming a view later does not rewrite what past rounds said.")
    sequence = fields.Integer(default=10)

    image = fields.Binary(string='Photograph', attachment=True, readonly=True)
    image_filename = fields.Char(readonly=True)
    file_size = fields.Integer(readonly=True, aggregator='sum')

    reference_image_id = fields.Many2one(
        'cleaning.reference.image', string='Compared Against',
        ondelete='set null', readonly=True)
    reference_write_date = fields.Datetime(
        string='Original As Of', readonly=True,
        help="When the original was last changed at the time this round was "
             "photographed.")
    reference_replaced = fields.Boolean(
        string='Original Has Changed Since',
        compute='_compute_reference_replaced')

    # --- measured, not guessed -------------------------------------------
    match_score = fields.Integer(
        string='Match', readonly=True, aggregator='avg',
        help="How closely this photograph matches the original, out of 100. "
             "Worked out here on this server, the same way every time.")
    match_level = fields.Selection(
        MATCH_LEVELS, string='Verdict', compute='_compute_match_level',
        search='_search_match_level')
    tile_score = fields.Integer(readonly=True)
    hash_score = fields.Integer(readonly=True)
    hash_distance = fields.Integer(readonly=True)
    match_error = fields.Char(
        string='Why It Could Not Be Compared', readonly=True)
    matched_at = fields.Datetime(readonly=True)

    # --- the AI's opinion, advisory only ---------------------------------
    ai_verdict = fields.Selection(
        [('match', 'Looks the same'),
         ('changed', 'Something has changed'),
         ('unclear', 'Cannot tell')],
        string='AI Verdict', default='unclear', readonly=True)
    ai_score = fields.Integer(
        string='AI Similarity', readonly=True,
        help="The model's own guess at how similar the two pictures are. "
             "Advisory: it wanders between runs, which is exactly why it is not "
             "what the warning is based on.")
    ai_changes = fields.Text(
        string='What Changed', readonly=True,
        help="The AI's description of what is different. This is the part no "
             "measurement can produce.")

    _uniq_direction = models.Constraint(
        'UNIQUE (recording_id, direction)',
        'This round already has a photograph for that direction.',
    )
    _check_match_score = models.Constraint(
        'CHECK (match_score >= 0 AND match_score <= 100)',
        'A match score has to be between 0 and 100.',
    )

    # ------------------------------------------------------------------
    @api.depends('reference_image_id.write_date', 'reference_write_date')
    def _compute_reference_replaced(self):
        """Has the original moved under this round's feet since it was taken?

        Worth surfacing rather than hiding: re-running a review months later
        compares against whatever the original is NOW, and a manager reading an
        old round deserves to know the goalposts moved. Cheaper and more honest
        than storing a copy of the original bytes against every single round.
        """
        for shot in self:
            reference = shot.reference_image_id
            shot.reference_replaced = bool(
                reference and shot.reference_write_date
                and reference.write_date
                and reference.write_date > shot.reference_write_date)

    @api.depends('match_score', 'match_error',
                 'recording_id.config_id.match_warn_threshold',
                 'recording_id.config_id.match_alert_threshold')
    def _compute_match_level(self):
        """Turn the score into the band a manager actually reads.

        Deliberately not stored. It depends on the thresholds in the settings,
        so storing it would mean that nudging a threshold recomputes every
        photograph ever taken, inside the settings form's own save. Left
        unstored it re-bands the whole history for free the moment the number
        changes.
        """
        for shot in self:
            config = shot.recording_id.config_id
            warn = config.match_warn_threshold or 60
            alert = config.match_alert_threshold or 50
            if shot.match_error or not shot.matched_at:
                shot.match_level = 'unknown'
            elif shot.match_score < alert:
                shot.match_level = 'alert'
            elif shot.match_score < warn:
                shot.match_level = 'warn'
            else:
                shot.match_level = 'ok'

    def _search_match_level(self, operator, value):
        """Let the bands be filtered even though they are not stored.

        The same trade the recording makes, for the same reason: leaving the
        field unstored is what lets a threshold change re-band the whole history
        for free, and translating a band back into a range of scores buys back
        the half of that which is actually used. Without this the Comparisons
        view cannot filter on a verdict at all - the view will not even load.
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
                    [('recording_id.config_id', '=', config.id)] + bands[band])
        if not clauses:
            return [('id', '=', False)]

        domain = clauses[0]
        for clause in clauses[1:]:
            domain = ['|'] + domain + clause
        return domain

    # ------------------------------------------------------------------
    def _attach_image(self, blob, filename, mimetype='image/jpeg'):
        """Store the photograph from bytes, the way _attach_video does.

        Downscaled on the way in, so what is compared, kept and later sent to
        an AI are all the same picture - and so re-running a comparison in six
        months gives the same answer as it did today.
        """
        self.ensure_one()
        try:
            blob = image_process(blob, size=(STORED_LONG_EDGE, STORED_LONG_EDGE),
                                 quality=STORED_QUALITY, output_format='JPEG')
        except Exception:  # noqa: BLE001 - Pillow and Odoo both raise widely
            # Keep the original bytes. A picture that cannot be resized is
            # still a picture, and refusing the round over it would be absurd.
            _logger.warning(
                "Showroom Check: could not resize a photograph for shot %s; "
                "storing it as it arrived", self.id)
        attachment = self.env['ir.attachment'].sudo().create({
            'name': filename,
            'res_model': self._name,
            'res_field': 'image',
            'res_id': self.id,
            'type': 'binary',
            'raw': blob,
            'mimetype': (mimetype or 'image/jpeg').split(';')[0].strip(),
        })
        self.sudo().write({
            'image_filename': filename,
            'file_size': attachment.file_size,
        })
        return attachment

    def _raw_image(self):
        """The stored bytes, without going through base64."""
        self.ensure_one()
        attachment = self.env['ir.attachment'].sudo().search([
            ('res_model', '=', self._name),
            ('res_field', '=', 'image'),
            ('res_id', '=', self.id),
        ], limit=1)
        return attachment.raw if attachment else None

    def _run_match_comparison(self):
        """Score each photograph against its original.

        Runs inline at upload, because somebody who has just photographed a
        room should be told straight away if a picture was unusable, and
        because four decodes is under a second.

        Never raises. A photograph that cannot be read leaves the round intact
        and says so in match_error - the same rule the recorder already follows
        for its stills: a nice-to-have may not take the recording down with it.
        """
        for shot in self:
            reference = shot.reference_image_id
            if not reference or not reference.signature:
                shot.sudo().write({
                    'match_error': "There is no original for this view to "
                                   "compare against.",
                    'matched_at': False,
                })
                continue
            try:
                result = compare.compare(
                    reference.signature, reference._phash_int(), shot._raw_image())
            except Exception as exc:  # noqa: BLE001 - never fail the upload
                _logger.exception(
                    "Showroom Check: comparison blew up on shot %s", shot.id)
                shot.sudo().write({'match_error': str(exc), 'matched_at': False})
                continue

            shot.sudo().write({
                'match_score': result['score'] or 0,
                'tile_score': result['tile_score'] or 0,
                'hash_score': result['hash_score'] or 0,
                'hash_distance': result['hash_distance'] or 0,
                'match_error': result['error'] or False,
                'matched_at': fields.Datetime.now() if result['score'] is not None else False,
            })
        return True
