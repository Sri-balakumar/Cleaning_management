import base64
import logging

from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.tools.image import image_process

from . import cleaning_image_compare as compare
from .cleaning_config import (
    DIRECTIONS, MATCH_LEVELS, STORED_LONG_EDGE, STORED_QUALITY,
    VIEW_MISMATCH_DISTANCE,
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
    # The original, as a field rather than a URL, so the card can render it
    # with the same widget as the photograph beside it and both open the
    # same way when clicked.
    reference_image = fields.Image(
        string='The Original', related='reference_image_id.image', readonly=True)
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
    view_mismatch = fields.Boolean(
        string='Possibly A Different View', compute='_compute_view_mismatch',
        help="The two photographs may not be of the same view at all, which "
             "is a different thing from the room having changed.")
    score_approximate = fields.Boolean(
        string='Score Is Approximate', compute='_compute_view_mismatch',
        help="The two photographs could not be lined up, so the score "
             "compares pixels that do not correspond to each other. A "
             "figure, but not a verdict.")
    poorly_framed = fields.Boolean(
        string='Too Differently Framed', compute='_compute_view_mismatch',
        help="The same view, but photographed from far enough away from the "
             "original that the two cannot be lined up, so the score means "
             "little.")
    # Feature matching, where OpenCV was there to do it. Empty on every
    # round taken before it was installed, and on every site without it.
    same_view = fields.Selection(
        [('yes', 'Same view'), ('no', 'Not the same view')],
        string='Same View', readonly=True,
        help="Whether the photograph is of the same thing as the original, "
             "judged on matching features rather than on brightness.")
    similarity = fields.Integer(
        string='Similar', readonly=True, aggregator='avg',
        help="How much of the same thing is in both pictures, out of 100. "
             "A different question from the match: a room that has been "
             "emptied is still highly similar to its original, because all "
             "the same walls are in shot.")
    match_count = fields.Integer(readonly=True)
    inlier_count = fields.Integer(readonly=True)
    registered = fields.Boolean(
        string='Lined Up Before Scoring', readonly=True,
        help="The photograph was warped onto the original before scoring, so "
             "the score compares pixels that correspond.")

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
    @api.depends('reference_image_id.image_write_date', 'reference_write_date')
    def _compute_reference_replaced(self):
        """Has the original moved under this round's feet since it was taken?

        Worth surfacing rather than hiding: re-running a review months later
        compares against whatever the original is NOW, and a manager reading an
        old round deserves to know the goalposts moved. Cheaper and more honest
        than storing a copy of the original bytes against every single round.

        Against image_write_date, NOT the record write_date. The question is
        whether the PICTURE changed, and the row is written for all sorts of
        reasons that leave it alone - renaming the view, editing what to look
        for, or a migration adding a column. Every one of those used to raise
        this warning on every round ever recorded.
        """
        for shot in self:
            reference = shot.reference_image_id
            shot.reference_replaced = bool(
                reference and shot.reference_write_date
                and reference.image_write_date
                and reference.image_write_date > shot.reference_write_date)

    @api.depends('same_view', 'registered', 'hash_distance', 'matched_at',
                 'match_error')
    def _compute_view_mismatch(self):
        """Are these even pictures of the same view?

        A separate question from the score, and one the score cannot answer:
        an original framed as a close-up of one corner and a round taken from
        across the room score 0, and so does a room somebody has emptied.
        Identical on screen, and only one of the two is anybody's fault.

        The dHash already knows. It is a coarse signal - 64 bits of overall
        shape - which is useless for spotting a missing bag and exactly right
        for 'that is not the same wall'.

        Unstored, like match_level and for the same reason: it hangs off a
        threshold, and storing it would mean that moving the threshold
        rewrites every photograph ever taken.

        Deliberately not gated on matched_at. A photograph that could not be
        lined up gets no score at all now, and these two lines are the only
        thing left to explain why - so they have to survive the very case
        they exist for. The dHash branch still is gated, because there
        hash_distance is written as (result['hash_distance'] or 0) and a hash
        that could not be computed is stored as the same 0 as a perfect
        match, which must never be reported as a mismatch.
        """
        for shot in self:
            shot.poorly_framed = False
            # Only where feature matching actually ran and failed to line
            # them up. Without OpenCV nothing knows either way, and calling
            # every score approximate would say something untrue about the
            # only measurement those sites have.
            shot.score_approximate = bool(
                shot.matched_at and not shot.match_error
                and shot.same_view and not shot.registered)
            if shot.match_error:
                shot.view_mismatch = False
            elif shot.same_view:
                # Feature matching answered it properly. Its answer wins:
                # it compares what is in the two pictures, where the hash
                # only compares their overall shape.
                shot.view_mismatch = shot.same_view == 'no'
                # The same view, and still not lined up. That is the case
                # nothing used to explain: the score reads 0 and the room
                # is fine, because the original was taken from somewhere
                # else entirely. Worth its own sentence - it is the one
                # that tells somebody what to actually do about it.
                shot.poorly_framed = (
                    shot.same_view == 'yes' and not shot.registered)
            elif shot.matched_at:
                shot.view_mismatch = (
                    shot.hash_distance >= VIEW_MISMATCH_DISTANCE)
            else:
                shot.view_mismatch = False

    @api.depends('match_score', 'match_error', 'score_approximate',
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
            # An approximate score bands as unknown. It is a real number
            # about the wrong pixels, and letting it turn the card red says
            # the room has changed when only the framing has.
            if shot.match_error or not shot.matched_at:
                shot.match_level = 'unknown'
            elif shot.score_approximate:
                shot.match_level = 'unaligned'
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
            # A row whose score could not be measured is none of ok, warn or
            # alert, whatever its number says. Expressed the long way round
            # because score_approximate is computed and cannot be searched:
            # it is exactly "feature matching ran and did not line them up",
            # so its opposite is "it did not run, or it did line them up".
            measured = ['|', ('same_view', '=', False),
                        ('registered', '=', True)]
            bands = {
                'ok': [('match_score', '>=', warn),
                       ('matched_at', '!=', False)] + measured,
                'warn': [('match_score', '>=', alert), ('match_score', '<', warn),
                         ('matched_at', '!=', False)] + measured,
                'alert': [('match_score', '<', alert),
                          ('matched_at', '!=', False)] + measured,
                'unaligned': [('matched_at', '!=', False),
                              ('match_error', '=', False),
                              ('same_view', '!=', False),
                              ('registered', '=', False)],
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

    def action_match_proof(self, everything=False):
        """The matched features drawn across both photographs, as base64.

        The web reads the same drawing from a controller route, which works
        there because a browser carries the session cookie. The app cannot:
        it attaches that cookie by hand on native, and Cookie is a header a
        browser refuses to let it set on web - so an <Image> pointed at a
        url would be unauthenticated on one platform or the other. Every
        server picture the app shows is fetched through this same door for
        exactly that reason.

        Returns False rather than raising where there is nothing to draw.
        A picture that will not load costs the picture, not the verdict
        beside it.
        """
        self.ensure_one()
        reference = self.reference_image_id
        if not reference or not reference.image or not self.image:
            return False
        drawing = compare.match_drawing(
            reference._raw_image(), self._raw_image(), everything=everything)
        if not drawing:
            return False
        return base64.b64encode(drawing).decode("ascii")

    def action_use_as_original(self):
        """Make this photograph the original for its view.

        The best original is one taken by the same person, on the same
        phone, from the place the round is actually walked - which is to
        say, one of the round photographs. Setting it from here makes the
        framing match by construction, where asking somebody to go and
        photograph the view again to the same framing rarely does.

        Writing the image is enough: the reference recomputes its
        signatures and descriptors on write. Every round is then re-scored
        against it, because the old scores were measured against a picture
        that no longer exists.
        """
        self.ensure_one()
        reference = self.reference_image_id
        if not reference:
            raise UserError(self.env._(
                "This photograph is not attached to one of the views, so "
                "there is nothing to set it as."))
        raw = self._raw_image()
        if not raw:
            raise UserError(self.env._(
                "This photograph could not be read, so it cannot be used "
                "as an original."))

        reference.sudo().write({
            'image': base64.b64encode(raw),
            'image_filename': self.image_filename or ('%s.jpg' % self.direction),
        })
        # Every round that was measured against the old picture, not just
        # this one - they are all now scored against something that is no
        # longer there.
        self.sudo().search([
            ('reference_image_id', '=', reference.id),
        ])._run_match_comparison()
        return True

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
                    reference.signature, reference._phash_int(),
                    shot._raw_image(), reference.features,
                    reference.signature_padded)
            except Exception as exc:  # noqa: BLE001 - never fail the upload
                _logger.exception(
                    "Showroom Check: comparison blew up on shot %s", shot.id)
                shot.sudo().write({'match_error': str(exc), 'matched_at': False})
                continue

            # Every score that was computed is recorded. Whether it means
            # anything is a different question and a different field:
            # score_approximate. Hiding the number entirely was tried and
            # is worse - people read a blank as a fault in the system,
            # where a figure marked approximate is read as what it is.
            shot.sudo().write({
                'match_score': result['score'] or 0,
                'tile_score': result['tile_score'] or 0,
                'hash_score': result['hash_score'] or 0,
                'hash_distance': result['hash_distance'] or 0,
                'match_error': result['error'] or False,
                'matched_at': (fields.Datetime.now()
                               if result['score'] is not None else False),
                'similarity': result['similarity'] or 0,
                'match_count': result['match_count'] or 0,
                'inlier_count': result['inlier_count'] or 0,
                'registered': result['registered'],
                # Left empty rather than guessed at when it could not be
                # asked: no OpenCV, or an original saved before it arrived.
                'same_view': (
                    False if result['same_view'] is None
                    else ('yes' if result['same_view'] else 'no')),
            })
        return True
