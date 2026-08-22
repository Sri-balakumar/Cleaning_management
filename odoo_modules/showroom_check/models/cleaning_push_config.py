import logging

from odoo import api, fields, models
from odoo.exceptions import UserError

from . import cleaning_push_provider as provider

_logger = logging.getLogger(__name__)


class CleaningPushConfig(models.Model):
    """Whether low rounds are pushed to managers' phones, and how patiently.

    Deliberately holds no credential. On the Expo path the Firebase service
    account key lives in the EAS account rather than here, uploaded once with
    `eas credentials`, and Expo authenticates to FCM on this server's behalf.
    Odoo needs nothing secret to ask Expo to deliver.

    That is a trade rather than a free win: Expo's push endpoint takes no
    Authorization header, so anybody holding a device's Expo token could push
    to it. kra_kpi_module accepts the same trade, and matching it keeps one
    pattern across both apps. Expo's push-security access token can be added
    later without changing anything else here.
    """
    _name = 'cleaning.push.config'
    _description = 'Cleaning Push Notification Settings'
    _order = 'company_id, id'

    name = fields.Char(required=True, default='Push Notification Settings')
    company_id = fields.Many2one(
        'res.company', string='Company', required=True, index=True,
        ondelete='cascade', default=lambda self: self.env.company)

    enabled = fields.Boolean(
        string='Send push notifications', default=False,
        help="With this off, low rounds still appear in the app's "
             "Notifications list. Nothing is sent to anybody's phone.")

    timeout_seconds = fields.Integer(
        string='Give Up After (seconds)', default=10,
        help="Kept short on purpose. Sending happens while a round is being "
             "uploaded, and a slow notification must never be the reason "
             "somebody's upload times out.")

    _uniq_company = models.Constraint(
        'UNIQUE (company_id)',
        'This company already has push notification settings.',
    )
    _check_timeout = models.Constraint(
        'CHECK (timeout_seconds > 0 AND timeout_seconds <= 60)',
        'The push timeout must be between 1 and 60 seconds.',
    )

    # ------------------------------------------------------------------
    @api.model
    def _get_for_company(self, company=None):
        company = company or self.env.company
        return self.search([('company_id', '=', company.id)], limit=1)

    def _ready(self):
        """Can this send? Cheap enough to call on every round."""
        self.ensure_one()
        return bool(self.enabled)

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------
    def _send_to_devices(self, devices, title, body, data=None):
        """Push one message to a set of phones. Returns how many got it.

        Batched per EAS project, because Expo rejects a request whose messages
        span two projects and delivers to NOBODY in it - so a single token left
        behind by an older projectId would otherwise cost every other manager
        their notification. kra_kpi_module carries a long comment about
        discovering this the hard way.

        Phones Expo reports as DeviceNotRegistered are retired rather than
        deleted, so the row survives as a record that this device existed.

        Never raises: the caller is usually in the middle of an upload.
        """
        self.ensure_one()
        if not devices:
            return 0
        timeout = self.timeout_seconds or provider.DEFAULT_TIMEOUT

        sent = 0
        retire = []
        for _project, group in devices._grouped_by_project().items():
            tokens = group.mapped('token')
            for start in range(0, len(tokens), provider.MAX_BATCH):
                chunk = tokens[start:start + provider.MAX_BATCH]
                messages = [
                    provider.build_message(token, title, body, data)
                    for token in chunk
                ]
                result = provider.send_batch(messages, timeout=timeout)
                sent += result['sent']
                retire.extend(result['retire'])

        if retire:
            gone = self.env['cleaning.push.device'].sudo().search([
                ('token', 'in', retire)])
            _logger.info(
                "Showroom Check: retiring %s phone(s) Expo reports as gone.",
                len(gone))
            gone.write({'active': False})
        return sent

    # ------------------------------------------------------------------
    # Buttons
    # ------------------------------------------------------------------
    def action_test_push(self):
        """Send a notification to whoever pressed the button.

        Deliberately to the caller's own phones and nobody else's: testing
        should not put a message on somebody else's screen.
        """
        self.ensure_one()
        devices = self.env['cleaning.push.device'].sudo().search([
            ('user_id', '=', self.env.user.id),
        ])
        if not devices:
            raise UserError(self.env._(
                "This account has no phone registered yet.\n\n"
                "Sign in to the app on the phone you want notifications on, "
                "as a Showroom Check Manager, and allow notifications when it "
                "asks. Then come back and press this again."))
        try:
            sent = self._send_to_devices(
                devices,
                self.env._("Showroom Check"),
                self.env._("Push notifications are working."),
                {'test': '1'})
        except provider.PushError as exc:
            raise UserError(str(exc))

        if not sent:
            raise UserError(self.env._(
                "Expo accepted the message for none of this account's phones. "
                "The server log says why - the usual cause is that the "
                "Firebase key on EAS does not match the build."))
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'type': 'success',
                'title': self.env._("Push Notifications"),
                'message': self.env._(
                    "Sent to %(count)s phone(s). Check the notification "
                    "appears.", count=sent),
                'sticky': False,
            },
        }

    def action_open_settings(self):
        """Open this company's push settings, creating them on first use."""
        config = self._get_for_company()
        if not config:
            config = self.create({'company_id': self.env.company.id})
        return {
            'type': 'ir.actions.act_window',
            'name': self.env._("Push Notifications"),
            'res_model': self._name,
            'res_id': config.id,
            'view_mode': 'form',
            'target': 'current',
        }
