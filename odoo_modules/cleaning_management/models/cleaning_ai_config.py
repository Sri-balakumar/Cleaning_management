import base64
import logging

from odoo import api, fields, models
from odoo.exceptions import UserError

from . import cleaning_ai_provider as provider

_logger = logging.getLogger(__name__)

# A 1x1 PNG, used only by Test connection. Sending a real picture (rather than
# text alone) means a text-only model is rejected here, at the moment somebody
# is testing the settings, instead of during a real review.
TEST_PIXEL = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8'
    'z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)


class CleaningAiConfig(models.Model):
    """Settings for the AI review, kept apart from the recording settings.

    Separate on purpose: this part is optional, it involves either a third party
    or a local server, and whoever sets up cleaning rounds is not necessarily
    the person holding an API key.
    """
    _name = 'cleaning.ai.config'
    _description = 'Cleaning AI Review Settings'
    _order = 'company_id, id'

    name = fields.Char(required=True, default='AI Review Settings')
    company_id = fields.Many2one(
        'res.company', string='Company', required=True, index=True,
        ondelete='cascade', default=lambda self: self.env.company)
    enabled = fields.Boolean(
        string='Enable AI Review', default=False,
        help="When this is off the Analyse button is hidden and nothing is "
             "ever sent anywhere.")

    provider = fields.Selection(
        [('gemini', 'Google Gemini (over the internet)'),
         ('ollama', 'Ollama / Llama (on your own network)'),
         ('openai_compatible', 'Other, OpenAI-compatible (LM Studio, vLLM...)')],
        string='AI Provider', required=True, default='gemini',
        help="Gemini sends the pictures to Google. Ollama keeps them entirely "
             "inside your own network, which matters when the footage shows "
             "staff at work.")
    base_url = fields.Char(
        string='Base URL',
        help="Where the AI service is.\n\n"
             "Ollama: something like http://localhost:11434\n"
             "Gemini: leave this empty to use Google's own address.")
    api_key = fields.Char(
        string='API Key / Token',
        groups='base.group_system',
        help="Needed for Gemini. A local Ollama usually needs nothing here, "
             "unless it sits behind a proxy that asks for a token.")
    model = fields.Char(
        string='Model', required=True, default='gemini-2.5-flash',
        help="Which model to use. It has to be one that can look at pictures - "
             "a text-only model will fail.\n\n"
             "Gemini: gemini-2.5-flash\n"
             "Ollama: llama3.2-vision (pull it first: ollama pull llama3.2-vision)")

    frames_per_recording = fields.Integer(
        string='Pictures Per Recording', default=3,
        help="How many stills are taken from the video and sent for review. "
             "Three - beginning, middle and end - is usually plenty. More costs "
             "more and rarely says anything new.")
    max_output_tokens = fields.Integer(string='Maximum Reply Length', default=1024)
    timeout_seconds = fields.Integer(
        string='Give Up After (seconds)', default=120,
        help="A local model on a machine with no graphics card can be slow. "
             "Raise this if reviews time out.")

    check_ids = fields.One2many(
        'cleaning.ai.check', 'config_id', string='What To Check')

    extra_instructions = fields.Text(
        string='Extra Instructions',
        help="Anything else the reviewer should know - for example 'the store "
             "room floor is permanently stained, ignore that' or 'chairs do not "
             "need to be tucked in'.")

    _uniq_company = models.Constraint(
        'UNIQUE (company_id)',
        'This company already has AI review settings.',
    )
    _check_frames = models.Constraint(
        'CHECK (frames_per_recording BETWEEN 1 AND 10)',
        'Pictures per recording must be between 1 and 10.',
    )

    # ------------------------------------------------------------------
    @api.onchange('provider')
    def _onchange_provider(self):
        """Suggest a model and address that suit the provider just picked."""
        for config in self:
            config.model = provider.DEFAULT_MODELS.get(config.provider) or ''
            if config.provider == 'ollama' and not config.base_url:
                config.base_url = 'http://localhost:11434'
            elif config.provider == 'gemini':
                config.base_url = False

    @api.model
    def _get_for_company(self, company=None):
        company = company or self.env.company
        return self.search([('company_id', '=', company.id)], limit=1)

    def _as_dict(self):
        """Plain dict for the provider layer, which knows nothing about Odoo."""
        self.ensure_one()
        record = self.sudo()
        return {
            'provider': record.provider,
            'base_url': (record.base_url or '').strip(),
            'api_key': (record.api_key or '').strip(),
            'model': (record.model or '').strip(),
            'max_output_tokens': record.max_output_tokens or 1024,
            'timeout': record.timeout_seconds or 120,
        }

    # ------------------------------------------------------------------
    # The prompt
    # ------------------------------------------------------------------
    def _build_prompt(self, slot_name=None):
        """Assemble the instructions that travel with the pictures.

        Each check's id is included in brackets so the reply can be matched back
        to the right row by number. Matching on the wording does not work - the
        model paraphrases it more often than not.
        """
        self.ensure_one()
        checks = self.check_ids.filtered('active').sorted(
            lambda c: (c.sequence, c.id))
        if not checks:
            raise UserError(self.env._(
                "There is nothing to check yet. Add at least one item under "
                "What To Check in the AI Review settings."))

        lines = [
            "You are reviewing photographs taken from a short video of an "
            "office area, recorded just after it was cleaned.",
            "",
            "Judge only what you can actually see. Where a picture is too dark, "
            "blurred or badly framed to tell, say so instead of guessing - an "
            "honest \"cannot tell\" is far more useful than a confident wrong "
            "answer.",
            "",
        ]
        if slot_name:
            lines += ["This is the round called \"%s\"." % slot_name, ""]

        lines.append("Check each of these points:")
        for check in checks:
            if check.description:
                lines.append("- [%s] %s - %s"
                             % (check.id, check.name, check.description))
            else:
                lines.append("- [%s] %s" % (check.id, check.name))

        if self.extra_instructions:
            lines += ["", "Also bear in mind:", self.extra_instructions.strip()]

        lines += [
            "",
            "Reply with JSON only, in exactly this shape:",
            "{",
            '  "score": <0-100, how clean the area looks overall>,',
            '  "summary": "<one or two sentences a manager can read at a glance>",',
            '  "issues": ["<each specific problem you can see>"],',
            '  "checks": [',
            '    {"id": <the number in brackets above>,',
            '     "passed": true or false or null,',
            '     "note": "<what you saw; use null for passed if you cannot tell>"}',
            "  ]",
            "}",
            "",
            "Include one entry in \"checks\" for every point listed above. "
            "Leave \"issues\" as an empty list if you can see nothing wrong.",
        ]
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def action_test_connection(self):
        """Prove the settings work without needing a real recording.

        Worth its own button: otherwise the first sign of a wrong address or a
        missing key is a failed review on a real round, which is both confusing
        and too late to do anything about.
        """
        self.ensure_one()
        try:
            raw, parsed = provider.analyse(
                self._as_dict(),
                'Reply with JSON only: {"ok": true}',
                [{'mimetype': 'image/png', 'data': TEST_PIXEL}],
            )
        except provider.AiError as exc:
            raise UserError(str(exc))

        message = self.env._(
            "Connected successfully.\n\nProvider: %(provider)s\nModel: %(model)s",
            provider=dict(self._fields['provider'].selection).get(self.provider),
            model=self.model,
        )
        if parsed is None:
            message += self.env._(
                "\n\nThe model answered, but not in JSON. Reviews will still "
                "work, though a reply may occasionally fail to be understood. "
                "Its answer began: %(start)s", start=(raw or '')[:120])
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': self.env._("AI Review"),
                'message': message,
                'type': 'success',
                'sticky': False,
            },
        }

    @api.model
    def action_open_settings(self):
        config = self._get_for_company()
        if not config:
            config = self.create({'company_id': self.env.company.id})
            config._create_default_checks()
        return {
            'type': 'ir.actions.act_window',
            'name': self.env._('AI Review Settings'),
            'res_model': 'cleaning.ai.config',
            'res_id': config.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def _create_default_checks(self):
        """A starting checklist, so a first review has something to say."""
        self.ensure_one()
        self.env['cleaning.ai.check'].create([
            {'config_id': self.id, 'sequence': 10,
             'name': 'Floor is clean',
             'description': 'No litter, dust, stains or spills on the floor'},
            {'config_id': self.id, 'sequence': 20,
             'name': 'Bins emptied',
             'description': 'Waste bins are empty or nearly so, nothing overflowing'},
            {'config_id': self.id, 'sequence': 30,
             'name': 'Surfaces wiped',
             'description': 'Desks and tables are clear of dust, crumbs and marks'},
            {'config_id': self.id, 'sequence': 40,
             'name': 'Area is tidy',
             'description': 'Chairs in place, no clutter or items left lying about'},
        ])


class CleaningAiCheck(models.Model):
    _name = 'cleaning.ai.check'
    _description = 'Cleaning AI Check Item'
    _order = 'sequence, id'

    config_id = fields.Many2one(
        'cleaning.ai.config', string='Settings', required=True,
        index=True, ondelete='cascade')
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    name = fields.Char(
        string='Check', required=True,
        help="Short name, for example 'Floor is clean'.")
    description = fields.Text(
        string='What Good Looks Like',
        help="Describe what passing means. The more specific this is, the more "
             "consistent the answers - 'no litter, dust or stains on the floor' "
             "works far better than 'floor ok'.")
    weight = fields.Integer(
        string='Weight', default=1,
        help="How much this counts towards the overall score, next to the "
             "other checks.")

    _check_weight = models.Constraint(
        'CHECK (weight > 0)', 'Weight must be greater than zero.')
