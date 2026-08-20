from odoo import fields, models


class CleaningCompareResult(models.TransientModel):
    """What the last "Compare again" found, shown once and thrown away.

    A dialog rather than a notification because the answer is a list: one line
    per view that moved. Odoo's display_notification escapes its message into a
    single-flow corner toast with no line breaks, which is right for "Saved"
    and useless for this.

    Transient, so it needs no cleanup of its own - the vacuum takes it. Nothing
    here is a record of anything; the record is the score on the shot.
    """
    _name = 'cleaning.compare.result'
    _description = 'What Comparing Again Found'

    recording_id = fields.Many2one('cleaning.recording', readonly=True)
    # Drives the wording and the icon: "nothing changed" is a good answer, not
    # a failed one, and should not be dressed as a warning.
    changed = fields.Boolean(readonly=True)
    summary = fields.Text(readonly=True)
