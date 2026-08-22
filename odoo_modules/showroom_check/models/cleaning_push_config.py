import json
import logging

from odoo import api, fields, models
from odoo.exceptions import UserError

from . import cleaning_push_provider as provider

_logger = logging.getLogger(__name__)


class CleaningPushConfig(models.Model):
    """Credentials for sending a push notification to a manager's phone.

    Its own model rather than more fields on cleaning.config, following
    cleaning.ai.config and for the same two reasons: this part is optional, and
    it holds a secret. Whoever sets up cleaning rounds is not necessarily the
    person who should be able to read a Firebase service account key.
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
        help="Off until the credentials below are filled in and Test Push has "
             "worked.\n\n"
             "With this off, low rounds still appear in the app's "
             "Notifications list. Nothing is ever sent to Google.")

    project_id = fields.Char(
        string='Firebase Project ID',
        help="From the Firebase console, under Project Settings.\n\n"
             "Leave it empty to use the project the service account file "
             "already names, which is almost always the right one.")
    service_account_key = fields.Text(
        string='Service Account Key (JSON)',
        groups='base.group_system',
        help="The WHOLE contents of the private key file, pasted in.\n\n"
             "Firebase console > Project Settings > Service Accounts > "
             "Generate new private key. This is not the same file as "
             "google-services.json, which belongs in the app rather than "
             "here - this one is a secret and lets a server send "
             "notifications as you.")
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

    def _key_dict(self):
        """The service account file, parsed.

        Raises PushError with something a person can act on. A key that will
        not parse is by far the most common setup mistake - people paste the
        path to the file, or half of it.
        """
        self.ensure_one()
        raw = (self.sudo().service_account_key or '').strip()
        if not raw:
            raise provider.PushError(
                "No service account key has been set. Paste the contents of "
                "the JSON file from Firebase into the Push settings.")
        try:
            parsed = json.loads(raw)
        except ValueError:
            raise provider.PushError(
                "The service account key is not valid JSON. Paste the whole "
                "contents of the file - it should start with a { and end with "
                "a } - rather than its filename or part of it.")
        if not isinstance(parsed, dict):
            raise provider.PushError(
                "The service account key should be a JSON object.")
        return parsed

    def _fcm_project_id(self, key_dict):
        """Which Firebase project to post to.

        The service account file already names its own project, so the field is
        a manual override rather than something anybody has to fill in. Taking
        it from the key by default also removes the mismatch where a key from
        one project is used with another project's id, which fails with a 404
        that explains nothing.
        """
        self.ensure_one()
        return (self.project_id or '').strip() or key_dict.get('project_id')

    def _ready(self):
        """Can this actually send? Cheap enough to call on every round."""
        self.ensure_one()
        return bool(self.enabled and self.sudo().service_account_key)

    def write(self, vals):
        """Forget any cached access token when the credentials change.

        Without this, editing the service account and pressing Test Push would
        keep using the token minted from the OLD key for up to an hour, and
        report a success that says nothing about the key just pasted.
        """
        if 'service_account_key' in vals:
            for config in self:
                try:
                    provider.forget_cached_token(config._key_dict())
                except provider.PushError:
                    # The key on the way out was unreadable, so there is no
                    # cached token under it to forget. Not worth failing a save.
                    pass
        return super().write(vals)

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------
    def _send_to_devices(self, devices, title, body, data=None):
        """Push one message to a set of devices. Returns how many got it.

        Dead tokens are deleted as they are discovered: FCM tells us when a
        phone is gone, and a token nobody removes is a request wasted on every
        future round, forever.

        Never raises. The caller is usually in the middle of an upload.
        """
        self.ensure_one()
        if not devices:
            return 0

        key = self._key_dict()
        project = self._fcm_project_id(key)
        if not project:
            raise provider.PushError(
                "No Firebase project id, and the service account file does "
                "not name one either.")
        timeout = self.timeout_seconds or provider.DEFAULT_TIMEOUT
        token = provider.access_token(key, timeout=timeout)

        sent = 0
        dead = self.env['cleaning.push.device']
        for device in devices:
            result = provider.send(
                project, token, device.token, title, body, data,
                timeout=timeout)
            if result['ok']:
                sent += 1
            elif result['dead']:
                dead |= device
            else:
                _logger.warning(
                    "Showroom Check: push to device %s failed: %s",
                    device.id, result['error'])
        if dead:
            _logger.info(
                "Showroom Check: removing %s device(s) Firebase reports as "
                "gone.", len(dead))
            dead.sudo().unlink()
        return sent

    # ------------------------------------------------------------------
    # Buttons
    # ------------------------------------------------------------------
    def action_test_push(self):
        """Send a notification to whoever pressed the button.

        Deliberately to the caller's own phones and nobody else's: testing
        credentials should not put a message on somebody else's screen.
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
                "The message was not accepted for any of this account's "
                "phones. The server log has the reason from Firebase."))
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
