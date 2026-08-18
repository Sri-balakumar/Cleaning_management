"""The AI review half of cleaning.recording.

Kept in its own file because it is optional: the module works perfectly well
with AI disabled, and separating it keeps the core recording logic readable.
"""
import logging

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError

from . import cleaning_ai_provider as provider

_logger = logging.getLogger(__name__)

# Frames are stored as ordinary attachments (no res_field), so they also show in
# the record's attachment area. This prefix is how we find them again.
FRAME_PREFIX = 'frame_'


class CleaningRecordingAi(models.Model):
    _inherit = 'cleaning.recording'

    ai_status = fields.Selection(
        [('not_run', 'Not reviewed'),
         ('done', 'Reviewed'),
         ('failed', 'Review failed')],
        string='AI Review', default='not_run', readonly=True, index=True)
    ai_score = fields.Integer(
        string='AI Score', readonly=True, aggregator='avg',
        help="How clean the area looked to the AI, from 0 to 100. Advisory "
             "only - it is a second opinion, not a verdict.")
    ai_summary = fields.Text(string='AI Summary', readonly=True)
    ai_issues = fields.Text(
        string='Problems Spotted', readonly=True,
        help="What the AI thought was wrong. Worth checking against the video "
             "before acting on it.")
    ai_checked_at = fields.Datetime(string='Reviewed At', readonly=True)
    ai_model_used = fields.Char(
        string='Model Used', readonly=True,
        help="Which model produced this. Kept because answers shift when the "
             "model or its version changes.")
    ai_error = fields.Text(string='Why It Failed', readonly=True)
    ai_result_ids = fields.One2many(
        'cleaning.ai.result', 'recording_id', string='Check Results',
        readonly=True)
    ai_raw_response = fields.Text(
        string='Raw AI Reply', readonly=True,
        groups='cleaning_management.group_cleaning_manager',
        help="Exactly what the model sent back. When a result looks wrong this "
             "is the only way to tell a bad question from a bad answer.")
    frame_count = fields.Integer(
        string='Pictures', compute='_compute_frame_count',
        help="Stills taken from the video at record time, which are what the "
             "AI actually looks at.")

    # ------------------------------------------------------------------
    def _frame_attachments(self):
        """The stills captured alongside this recording, in order."""
        self.ensure_one()
        return self.env['ir.attachment'].sudo().search([
            ('res_model', '=', self._name),
            ('res_id', '=', self.id),
            ('res_field', '=', False),
            ('name', 'like', FRAME_PREFIX + '%'),
        ], order='name')

    @api.depends('write_date')
    def _compute_frame_count(self):
        for recording in self:
            recording.frame_count = (
                len(recording._frame_attachments()) if recording.id else 0)

    def _store_frames(self, frames):
        """Save the stills that came up with the video.

        `frames` is a list of (bytes, mimetype). Stored as normal attachments so
        they are visible, downloadable and removed with the record.
        """
        self.ensure_one()
        Attachment = self.env['ir.attachment'].sudo()
        for index, (blob, mimetype) in enumerate(frames, start=1):
            Attachment.create({
                'name': '%s%02d.jpg' % (FRAME_PREFIX, index),
                'res_model': self._name,
                'res_id': self.id,
                'type': 'binary',
                'raw': blob,
                'mimetype': (mimetype or 'image/jpeg').split(';')[0].strip(),
            })

    # ------------------------------------------------------------------
    # Running a review
    # ------------------------------------------------------------------
    def action_ai_analyse(self):
        """Send this recording's stills for review. Manager only, on demand.

        Deliberately manual: reviews cost money on a hosted model and time on a
        local one, and nobody should be surprised by either.
        """
        for recording in self:
            recording._ai_analyse_one()

        if len(self) == 1 and self.ai_status == 'done':
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': self.env._("AI Review"),
                    'message': self.env._(
                        "Score %(score)s out of 100. %(summary)s",
                        score=self.ai_score, summary=self.ai_summary or ''),
                    'type': 'info',
                    'sticky': False,
                },
            }
        return True

    def _ai_analyse_one(self):
        self.ensure_one()

        if not self.env.user.has_group(
                'cleaning_management.group_cleaning_manager'):
            raise AccessError(self.env._(
                "Only a Cleaning Management Manager can run an AI review."))

        config = self.env['cleaning.ai.config'].sudo()._get_for_company(
            self.company_id or self.env.company)
        if not config or not config.enabled:
            raise UserError(self.env._(
                "AI review is switched off. Turn it on under Cleaning > "
                "Configuration > AI Review."))

        attachments = self._frame_attachments()
        if not attachments:
            raise UserError(self.env._(
                "This recording has no pictures stored with it, so there is "
                "nothing to review.\n\n"
                "Pictures are captured while recording, so only recordings "
                "made after AI review was set up can be reviewed."))

        # Evenly spaced across however many were captured, so a shorter list
        # still covers beginning, middle and end rather than three near-identical
        # frames from the start.
        wanted = max(1, min(config.frames_per_recording, len(attachments)))
        if wanted >= len(attachments):
            chosen = attachments
        else:
            step = (len(attachments) - 1) / float(wanted - 1) if wanted > 1 else 0
            indexes = sorted({int(round(i * step)) for i in range(wanted)})
            chosen = attachments.browse([attachments[i].id for i in indexes])

        images = [{
            'mimetype': att.mimetype or 'image/jpeg',
            'data': att.with_context(bin_size=False).raw,
        } for att in chosen]

        prompt = config._build_prompt(slot_name=self.slot_id.name)

        try:
            raw, parsed = provider.analyse(config._as_dict(), prompt, images)
        except provider.AiError as exc:
            self._ai_record_failure(str(exc), config)
            raise UserError(str(exc))

        if parsed is None:
            self._ai_record_failure(
                self.env._(
                    "The model's reply could not be understood as JSON. Its "
                    "raw answer has been kept on the recording."),
                config, raw=raw)
            raise UserError(self.env._(
                "The AI answered, but not in a form this module could read. "
                "The raw reply is stored on the recording under Raw AI Reply.\n\n"
                "If this keeps happening, the model probably is not good at "
                "following a required format - try a different one."))

        self._ai_apply_result(parsed, raw, config)

    def _ai_record_failure(self, message, config, raw=None):
        """Never leave a stale score sitting next to a failed review."""
        self.sudo().write({
            'ai_status': 'failed',
            'ai_error': message,
            'ai_raw_response': raw or False,
            'ai_checked_at': fields.Datetime.now(),
            'ai_model_used': config.model,
            'ai_score': 0,
            'ai_summary': False,
            'ai_issues': False,
        })
        self.sudo().ai_result_ids.unlink()
        _logger.warning(
            "cleaning.recording %s: AI review failed - %s", self.id, message)

    def _ai_apply_result(self, parsed, raw, config):
        self.ensure_one()

        checks_by_id = {c.id: c for c in config.check_ids}
        rows = []
        for entry in (parsed.get('checks') or []):
            if not isinstance(entry, dict):
                continue
            try:
                check = checks_by_id.get(int(entry.get('id')))
            except (TypeError, ValueError):
                check = None

            passed_raw = entry.get('passed')
            if passed_raw is True:
                passed = 'yes'
            elif passed_raw is False:
                passed = 'no'
            else:
                # null, missing, or anything unexpected. "Cannot tell" is the
                # honest reading - never silently downgrade it to a failure.
                passed = 'unclear'

            rows.append({
                'check_id': check.id if check else False,
                # Name copied rather than related, so editing the checklist
                # later does not rewrite what past reviews reported.
                'name': check.name if check else (
                    entry.get('name') or self.env._('(deleted check)')),
                'sequence': check.sequence if check else 99,
                'passed': passed,
                'note': entry.get('note') or False,
            })

        issues = parsed.get('issues')
        if isinstance(issues, (list, tuple)):
            issues_text = "\n".join(
                '- %s' % str(item).strip() for item in issues if str(item).strip())
        else:
            issues_text = str(issues).strip() if issues else ''

        try:
            score = int(round(float(parsed.get('score'))))
        except (TypeError, ValueError):
            score = 0
        score = max(0, min(100, score))

        self.sudo().ai_result_ids.unlink()
        self.sudo().write({
            'ai_status': 'done',
            'ai_score': score,
            'ai_summary': (parsed.get('summary') or '').strip() or False,
            'ai_issues': issues_text or False,
            'ai_error': False,
            'ai_raw_response': raw,
            'ai_checked_at': fields.Datetime.now(),
            'ai_model_used': config.model,
            'ai_result_ids': [(0, 0, row) for row in rows],
        })
        _logger.info(
            "cleaning.recording %s reviewed by %s: score %s",
            self.id, config.model, score)
