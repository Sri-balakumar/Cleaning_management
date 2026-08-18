import base64
import binascii

from odoo import api, fields, models

from . import cleaning_image_compare as compare
from .cleaning_config import DIRECTIONS


class CleaningReferenceImage(models.Model):
    """One original photograph: this is how this view of the room should look.

    Four of these per office, one per direction, set once by a manager. Every
    round is measured against them, which makes this the specification the
    whole feature is written against - if a direction has no original, there is
    nothing to compare that direction to and it is simply not asked for.

    A row per direction rather than four Binary fields on the settings record,
    because each direction needs a picture, a label, a filename, instructions
    and two precomputed comparison values. Flat fields would be twenty-four
    columns on a record that is read every sixty seconds by every dashboard,
    with multi-megabyte binaries hanging off it - and replacing one photograph
    would be a write to the settings record, re-firing every unrelated
    constraint it has.
    """
    _name = 'cleaning.reference.image'
    _description = 'Showroom Reference Photograph'
    _order = 'sequence, id'

    config_id = fields.Many2one(
        'cleaning.config', string='Settings', required=True,
        index=True, ondelete='cascade')
    company_id = fields.Many2one(
        related='config_id.company_id', store=True, index=True, readonly=True)

    # Fixed forever, and readonly in every view. Everything matches on this.
    direction = fields.Selection(
        DIRECTIONS, string='Direction', required=True, index=True,
        readonly=True)
    name = fields.Char(
        string='What This Shows', required=True,
        help="Your own words for this view - \"Systems\", \"Bags area\". This "
             "is what people are shown when they are asked to photograph it, "
             "so name it after what is in it rather than which way it faces.")
    sequence = fields.Integer(default=10)

    image = fields.Binary(string='Original', attachment=True)
    image_filename = fields.Char(string='File Name')
    instructions = fields.Text(
        string='What To Look For',
        help="Optional. Anything a person should know when photographing this "
             "view - \"stand by the door\", \"every desk has its chair\".")

    has_image = fields.Boolean(
        string='Set', compute='_compute_has_image',
        help="Whether an original has been uploaded for this view yet. Views "
             "without one are skipped: there would be nothing to compare.")

    # Precomputed when the original is saved, so a daily round only ever
    # decodes the four photographs that just arrived - never the four it is
    # comparing them against.
    signature = fields.Char(readonly=True, copy=False)
    phash = fields.Char(readonly=True, copy=False)

    _uniq_direction = models.Constraint(
        'UNIQUE (config_id, direction)',
        'This office already has an original photograph for that direction.',
    )

    # ------------------------------------------------------------------
    @api.depends('image')
    def _compute_has_image(self):
        for reference in self:
            reference.has_image = bool(reference.image)

    @api.depends('name', 'direction')
    def _compute_display_name(self):
        labels = dict(self._fields['direction'].selection)
        for reference in self:
            direction = labels.get(reference.direction, '')
            reference.display_name = (
                '%s (%s)' % (reference.name, direction.lower())
                if reference.name and direction else (reference.name or direction))

    # ------------------------------------------------------------------
    def _prepare_signature(self, vals):
        """Refresh the stored comparison values when the picture changes.

        Done on write rather than as a computed field because it is expensive
        (a full decode) and depends on bytes rather than on other fields. A
        picture that cannot be read leaves both empty, which the comparison
        reports as "not prepared yet" instead of failing somebody's round.
        """
        if 'image' not in vals:
            return
        if not vals.get('image'):
            vals['signature'] = False
            vals['phash'] = False
            return
        try:
            raw = base64.b64decode(vals['image'])
        except (TypeError, ValueError, binascii.Error):
            vals['signature'] = False
            vals['phash'] = False
            return
        signature, phash = compare.signature_for(raw)
        vals['signature'] = signature or False
        vals['phash'] = ('%016x' % phash) if phash is not None else False

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            self._prepare_signature(vals)
        return super().create(vals_list)

    def write(self, vals):
        self._prepare_signature(vals)
        return super().write(vals)

    # ------------------------------------------------------------------
    def _raw_image(self):
        """The stored bytes, without a round trip through base64."""
        self.ensure_one()
        attachment = self.env['ir.attachment'].sudo().search([
            ('res_model', '=', self._name),
            ('res_field', '=', 'image'),
            ('res_id', '=', self.id),
        ], limit=1)
        return attachment.raw if attachment else None

    def _phash_int(self):
        """The stored hash as an integer, or None if it was never computed."""
        self.ensure_one()
        try:
            return int(self.phash, 16) if self.phash else None
        except (TypeError, ValueError):
            return None
