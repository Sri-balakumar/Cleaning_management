"""The AI review half of cleaning.recording.

Kept in its own file because it is optional: the module works perfectly well
with AI disabled, and separating it keeps the core recording logic readable.
"""
import logging

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError
from odoo.tools.image import image_process

from . import cleaning_ai_provider as provider

_logger = logging.getLogger(__name__)

# Frames are stored as ordinary attachments (no res_field), so they also show in
# the record's attachment area. This prefix is how we find them again.
FRAME_PREFIX = 'frame_'


def _as_bullet_text(value):
    """A list or a string from the model, as one block of bullet lines.

    Models are inconsistent about whether they answer with a list or with one
    sentence, and both readings are reasonable. Shared by the round's overall
    issues and by each view's list of changes so the two always look the same.
    """
    if isinstance(value, (list, tuple)):
        return "\n".join(
            '- %s' % str(item).strip() for item in value if str(item).strip())
    return str(value).strip() if value else ''


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
        groups='showroom_check.group_cleaning_manager',
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
    # What the model gets to look at
    # ------------------------------------------------------------------
    def _ai_image_payload(self, blob, mimetype='image/jpeg'):
        """One entry for the provider, downscaled for the wire.

        Photographs are already stored at 1600px, but the video stills are not
        processed at all, and either way there is no point sending more than a
        model will look at. Four pairs at 1600px base64s to roughly 8 MB of
        request body; at 1024px it is a fraction of that and nothing is lost -
        no vision model resolves a request at that size anyway.
        """
        if not blob:
            return None
        try:
            blob = image_process(blob, size=(1024, 1024), quality=80,
                                 output_format='JPEG')
            mimetype = 'image/jpeg'
        except Exception:  # noqa: BLE001 - send it as it is rather than fail
            _logger.debug("Could not downscale a picture for the AI request",
                          exc_info=True)
        return {'mimetype': mimetype or 'image/jpeg', 'data': blob}

    def _ai_comparison_images(self):
        """(images, pairs) for the before-and-after half of the review.

        `images` is the flat list handed to the provider: the original then
        today's photograph, for each view in turn. `pairs` describes that same
        list in words so the prompt can say which picture is which - the
        provider APIs take one array and attach no labels of their own, so
        without this the model is looking at eight unlabelled pictures.

        Interleaved, original first, rather than all the originals followed by
        all the captures. A model attends far better to two pictures sitting
        next to each other, and if it loses count half way the damage is
        contained to one view instead of shifting every single mapping by one.
        """
        self.ensure_one()
        images = []
        pairs = []
        for shot in self.shot_ids.sorted(lambda s: (s.sequence, s.id)):
            reference = shot.reference_image_id
            if not reference:
                continue
            original = self._ai_image_payload(reference.sudo()._raw_image())
            capture = self._ai_image_payload(shot.sudo()._raw_image())
            if not original or not capture:
                continue
            pairs.append({
                'key': shot.direction,
                'label': shot.name,
                'original_index': len(images) + 1,   # 1-based, as the prompt says
                'capture_index': len(images) + 2,
            })
            images += [original, capture]
        return images, pairs

    def _ai_still_images(self, config):
        """The evenly spaced stills cut from the video."""
        self.ensure_one()
        attachments = self._frame_attachments()
        if not attachments:
            return []

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

        payloads = [
            self._ai_image_payload(att.with_context(bin_size=False).raw,
                                   att.mimetype or 'image/jpeg')
            for att in chosen
        ]
        return [payload for payload in payloads if payload]

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
                'showroom_check.group_cleaning_manager'):
            raise AccessError(self.env._(
                "Only a Showroom Check Manager can run an AI review."))

        config = self.env['cleaning.ai.config'].sudo()._get_for_company(
            self.company_id or self.env.company)
        if not config or not config.enabled:
            raise UserError(self.env._(
                "AI review is switched off. Turn it on under Cleaning > "
                "Configuration > AI Review."))

        pair_images, pairs = self._ai_comparison_images()

        # The stills answer "is it clean?", which the checklist already covers,
        # and they are worse pictures than the four photographs. Sending both
        # is eleven images in one request, which makes the model worse at all of
        # them. So when a round has photographs, the stills stay behind unless
        # somebody has deliberately asked for them.
        stills = (self._ai_still_images(config)
                  if (config.include_video_stills or not pairs) else [])
        images = pair_images + stills

        if not images:
            raise UserError(self.env._(
                "This round has no pictures stored with it, so there is "
                "nothing to review.\n\n"
                "Pictures are captured while recording, so only rounds made "
                "after AI review was set up can be reviewed."))

        prompt = config._build_prompt(
            slot_name=self.slot_id.name, pairs=pairs, still_count=len(stills))

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

    def _ai_apply_directions(self, entries):
        """Write the model's per-view verdicts onto the photographs.

        Matched on the fixed direction key, never on the label or on position
        in the list: labels are the manager's own words and get paraphrased,
        and a model that drops one entry would otherwise shift every remaining
        verdict onto the wrong view.

        A view the model said nothing about keeps 'unclear', which is the
        honest reading. Keys that mean nothing here are ignored rather than
        being an error - the review is worth keeping even when part of the
        reply was nonsense.
        """
        self.ensure_one()
        if not isinstance(entries, (list, tuple)):
            return
        by_direction = {shot.direction: shot for shot in self.shot_ids}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            shot = by_direction.get(entry.get('key'))
            if not shot:
                continue
            verdict = entry.get('verdict')
            if verdict not in ('same', 'changed', 'unclear'):
                verdict = 'unclear'
            try:
                similarity = max(0, min(100, int(round(float(
                    entry.get('similarity'))))))
            except (TypeError, ValueError):
                similarity = 0
            shot.sudo().write({
                'ai_verdict': 'match' if verdict == 'same' else verdict,
                'ai_score': similarity,
                'ai_changes': _as_bullet_text(entry.get('changes')) or False,
            })

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

        self._ai_apply_directions(parsed.get('directions'))

        issues_text = _as_bullet_text(parsed.get('issues'))

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
