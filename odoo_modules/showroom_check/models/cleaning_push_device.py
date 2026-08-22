import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

PLATFORMS = [
    ('android', 'Android'),
    ('ios', 'iOS'),
]


class CleaningPushDevice(models.Model):
    """One phone that has asked to be told about low rounds.

    The app hands over the address Firebase gave it; this is where that address
    is kept. Nothing else about the phone is stored - not a name, not a model,
    not a location. A token and who it belongs to is all that sending needs.
    """
    _name = 'cleaning.push.device'
    _description = 'Cleaning Push Device'
    _order = 'last_seen_at desc, id desc'
    _rec_name = 'token'

    user_id = fields.Many2one(
        'res.users', string='User', required=True, index=True,
        ondelete='cascade',
        help="Who this phone notifies. A phone that somebody else signs in on "
             "moves to them.")
    token = fields.Char(
        string='Device Token', required=True, index=True,
        help="Technical: the address Firebase gave the app. It changes when "
             "the app is reinstalled or its data cleared, so the app sends it "
             "again on every sign-in.")
    platform = fields.Selection(
        PLATFORMS, string='Platform', default='android', required=True)
    company_id = fields.Many2one(
        'res.company', string='Company', index=True,
        default=lambda self: self.env.company)
    last_seen_at = fields.Datetime(
        string='Last Registered',
        help="When the app last confirmed this token. A phone that stops "
             "appearing here has been signed out of, reinstalled, or lost.")

    _uniq_token = models.Constraint(
        'UNIQUE (token)',
        'This phone is already registered.',
    )

    # ------------------------------------------------------------------
    @api.model
    def register_device(self, token, platform='android'):
        """Remember this phone for the signed-in user. Called by the app.

        Returns True when the phone was registered, False when it was not -
        never an error. A phone that cannot register should fall back to the
        in-app Notifications list quietly, not fail somebody's sign-in.

        Managers only, because nobody else is ever notified. Registering
        everybody's phone would collect device tokens the server has no use
        for, which is worth avoiding on its own.
        """
        token = (token or '').strip()
        if not token:
            return False
        if not self.env.user.has_group('showroom_check.group_cleaning_manager'):
            return False
        if platform not in dict(PLATFORMS):
            platform = 'android'

        now = fields.Datetime.now()
        # sudo() because the token may currently belong to somebody else: a
        # shared phone that a second manager signs in on must move, not end up
        # notifying whoever used it last week. The record rules would hide that
        # row from the person doing the signing in, and the unique constraint
        # would then fail on a token nobody can see.
        existing = self.sudo().search([('token', '=', token)], limit=1)
        if existing:
            existing.write({
                'user_id': self.env.user.id,
                'platform': platform,
                'company_id': self.env.company.id,
                'last_seen_at': now,
            })
            return True

        self.sudo().create({
            'user_id': self.env.user.id,
            'token': token,
            'platform': platform,
            'company_id': self.env.company.id,
            'last_seen_at': now,
        })
        return True

    @api.model
    def unregister_device(self, token):
        """Forget this phone. Called when somebody signs out of the app.

        Without it, a manager who hands their phone on, or signs out for the
        last time, keeps being sent every low round indefinitely - Firebase has
        no idea anything changed, because the app is still installed.
        """
        token = (token or '').strip()
        if not token:
            return False
        self.sudo().search([('token', '=', token)]).unlink()
        return True
