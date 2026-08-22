import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

PLATFORMS = [
    ('android', 'Android'),
    ('ios', 'iOS'),
]


class CleaningPushDevice(models.Model):
    """One phone that has asked to be told about low rounds.

    The app hands over the Expo push token Expo gave it; this is where that
    address is kept. Nothing else about the phone is stored beyond a readable
    name, so a manager looking at Registered Phones sees "Galaxy Tab A" rather
    than a fragment of a token.

    Shaped after kra_kpi_module's kpi.push.token, deliberately, so both apps
    keep their devices the same way.
    """
    _name = 'cleaning.push.device'
    _description = 'Cleaning Push Device'
    _order = 'last_seen_at desc, id desc'
    _rec_name = 'device'

    user_id = fields.Many2one(
        'res.users', string='User', required=True, index=True,
        ondelete='cascade',
        help="Who this phone notifies. A phone that somebody else signs in on "
             "moves to them.")
    token = fields.Char(
        string='Expo Push Token', required=True, index=True,
        help="Technical: the address Expo gave the app. It changes when the "
             "app is reinstalled or its data cleared, so the app sends it "
             "again on every sign-in.")
    platform = fields.Selection(
        PLATFORMS, string='Platform', default='android', required=True)
    device = fields.Char(
        string='Device',
        help="What the phone calls itself, so this list is readable.")
    project_id = fields.Char(
        string='EAS Project',
        help="Technical: which EAS project minted this token.\n\n"
             "Load-bearing rather than informational. Expo rejects a request "
             "whose messages span two projects - and rejects the WHOLE "
             "request, so one token left behind by an older project would "
             "take every other phone's notification down with it. Sends are "
             "grouped by this.")
    active = fields.Boolean(
        string='Active', default=True,
        help="Cleared when Expo reports the phone as gone. Retired rather "
             "than deleted, so the row survives as a record that it existed.")
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
    def register_device(self, token, platform='android', device=None,
                        project_id=None):
        """Remember this phone for the signed-in user. Called by the app.

        Returns True when the phone was registered, False when it was not -
        never an error. A phone that cannot register should fall back to the
        in-app Notifications list quietly, not fail somebody's sign-in.

        Managers only, because nobody else is ever notified. Registering
        everybody's phone would collect tokens the server has no use for.
        """
        token = (token or '').strip()
        if not token:
            return False
        if not self.env.user.has_group('showroom_check.group_cleaning_manager'):
            return False
        if platform not in dict(PLATFORMS):
            platform = 'android'

        values = {
            'user_id': self.env.user.id,
            'platform': platform,
            'device': (device or '')[:100] or False,
            'project_id': (project_id or '').strip() or False,
            'company_id': self.env.company.id,
            'last_seen_at': fields.Datetime.now(),
            # Signing in again un-retires a phone Expo had written off. The
            # token is demonstrably alive: it was just minted.
            'active': True,
        }

        # sudo() because the token may currently belong to somebody else: a
        # shared phone that a second manager signs in on must move, not end up
        # notifying whoever used it last week. The record rules would hide that
        # row from the person signing in, and the unique constraint would then
        # fail on a row nobody can see. active=False rows are searched too,
        # for the same reason.
        existing = self.sudo().with_context(active_test=False).search(
            [('token', '=', token)], limit=1)
        if existing:
            existing.write(values)
            return True

        self.sudo().create(dict(values, token=token))
        return True

    @api.model
    def unregister_device(self, token):
        """Forget this phone. Called when somebody signs out of the app.

        A real delete rather than a retirement: signing out is somebody saying
        so, where active=False means Expo told us. Without this a manager who
        hands their phone on keeps being sent every low round indefinitely.
        """
        token = (token or '').strip()
        if not token:
            return False
        self.sudo().with_context(active_test=False).search(
            [('token', '=', token)]).unlink()
        return True

    def _grouped_by_project(self):
        """{project_id: devices}, so each Expo request covers one project.

        The whole defence against Expo's all-or-nothing rejection. Tokens
        registered before project_id existed share the False group; they are
        sent together and, if they do turn out to span projects, fail together
        rather than taking the known-good groups with them.
        """
        groups = {}
        for device in self:
            groups.setdefault(device.project_id or False, self.browse())
            groups[device.project_id or False] |= device
        return groups
