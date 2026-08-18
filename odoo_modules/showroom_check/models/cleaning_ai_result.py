from odoo import fields, models


class CleaningAiResult(models.Model):
    """One checklist point, as judged on one recording."""
    _name = 'cleaning.ai.result'
    _description = 'Cleaning AI Check Result'
    _order = 'sequence, id'

    recording_id = fields.Many2one(
        'cleaning.recording', string='Recording', required=True,
        index=True, ondelete='cascade')
    check_id = fields.Many2one(
        'cleaning.ai.check', string='Check', ondelete='set null',
        help="Empty when the checklist item has since been deleted. The name "
             "below is kept regardless, so old reviews stay readable.")
    name = fields.Char(
        string='Check', required=True,
        help="Copied from the checklist at the time of the review, so editing "
             "or deleting a check later does not rewrite what was reported.")
    sequence = fields.Integer(default=10)

    # Three-valued on purpose. A model that cannot see enough to judge should
    # say so, and 'unclear' is genuinely different from 'failed' - treating
    # them the same would quietly turn a dark picture into a black mark.
    passed = fields.Selection(
        [('yes', 'Yes'), ('no', 'No'), ('unclear', 'Cannot tell')],
        string='Result', default='unclear', required=True)
    note = fields.Text(string='What The AI Saw')

    company_id = fields.Many2one(
        related='recording_id.company_id', store=True, index=True, readonly=True)
