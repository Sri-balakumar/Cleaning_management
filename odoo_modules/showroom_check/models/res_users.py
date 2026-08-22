from odoo import fields, models


class ResUsers(models.Model):
    """One marker per user: when they last looked at the low-round list.

    A single datetime rather than a notification table with a read flag per
    row, and that is the whole design. The list of low rounds is DERIVED - it
    is a search for rounds under the threshold - so moving the threshold
    re-bands the entire history for free, exactly as leaving match_level
    unstored does for the verdicts themselves (see the note on
    _compute_match_level in cleaning_recording_shot.py).

    Stored notification rows would freeze the threshold at the moment each row
    was written. Drop the number from 60 to 50 next month and the old rows
    would still claim to be failures, while nothing would explain why.
    """
    _inherit = 'res.users'

    cleaning_notifications_seen_at = fields.Datetime(
        string='Low Rounds Seen At',
        help="Technical: everything scored since this counts as unread. Set "
             "when the Notifications screen is opened in the app.")
