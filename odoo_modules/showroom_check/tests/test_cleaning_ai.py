"""AI review tests.

None of these touch the network. The provider layer is exercised by swapping
out its one HTTP function, so the payloads are checked without a key, an
internet connection, or a bill.
"""
from datetime import datetime

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged

from ..models import cleaning_ai_provider as ai_provider


@tagged('post_install', '-at_install')
class TestCleaningAi(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Its own company, so the tests never touch real configuration or
        # recordings. See the note in test_showroom_check.py.
        cls.company = cls.env['res.company'].create({'name': 'Cleaning AI Test Co'})
        cls.env.user.company_ids = [(4, cls.company.id)]
        cls.env = cls.env(context=dict(
            cls.env.context, allowed_company_ids=[cls.company.id]))

        cls.config = cls.env['cleaning.config'].create({
            'company_id': cls.company.id,
            'timezone': 'Asia/Kolkata',
        })
        cls.slot = cls.env['cleaning.slot'].create({
            'config_id': cls.config.id,
            'name': 'Morning Round',
            'hour_from': 9.0,
            'hour_to': 10.0,
            'mon': True, 'tue': True, 'wed': True, 'thu': True,
            'fri': True, 'sat': True, 'sun': True,
        })

    def _ai_config(self, **overrides):
        values = {
            'company_id': self.company.id,
            'enabled': True,
            'provider': 'gemini',
            'api_key': 'test-key',
            'model': 'gemini-2.5-flash',
        }
        values.update(overrides)
        config = self.env['cleaning.ai.config'].create(values)
        config._create_default_checks()
        return config

    def _recording(self):
        started = datetime(2026, 8, 17, 3, 40)  # 09:10 India time
        return self.env['cleaning.recording'].create({
            'slot_id': self.slot.id,
            'slot_date': self.config._local_date(started),
            'user_id': self.env.user.id,
            'started_at': started,
        })

    # ------------------------------------------------------------------
    # Reading the model's reply
    # ------------------------------------------------------------------
    def test_json_from_a_clean_reply(self):
        self.assertEqual(ai_provider.extract_json('{"score": 80}'), {'score': 80})

    def test_json_from_a_fenced_reply(self):
        """Local models very often wrap the object in a code fence."""
        fenced = '```json\n{"score": 70}\n```'
        self.assertEqual(ai_provider.extract_json(fenced), {'score': 70})
        self.assertEqual(
            ai_provider.extract_json('```\n{"score": 71}\n```'), {'score': 71})

    def test_json_from_a_reply_with_prose_around_it(self):
        """...and just as often write a sentence first."""
        reply = 'Sure! Here is my assessment:\n{"score": 60, "issues": []}\nHope that helps.'
        self.assertEqual(ai_provider.extract_json(reply), {'score': 60, 'issues': []})

    def test_unreadable_replies_give_none_rather_than_a_guess(self):
        for reply in ('the room looks fine to me', '', None, '{"broken": '):
            self.assertIsNone(ai_provider.extract_json(reply))

    # ------------------------------------------------------------------
    # The prompt
    # ------------------------------------------------------------------
    def test_prompt_lists_every_check_with_its_id(self):
        config = self._ai_config()
        prompt = config._build_prompt(slot_name='Morning Round')
        for check in config.check_ids:
            # The id must travel with the wording. Models paraphrase the
            # wording, so the number is the only reliable way back to the row.
            self.assertIn('[%s]' % check.id, prompt)
        self.assertIn('Morning Round', prompt)
        # It should be told that "cannot tell" is an acceptable answer, or it
        # will guess when a picture is too dark to judge.
        self.assertIn('cannot tell', prompt.lower())

    def test_prompt_refuses_when_there_is_nothing_to_check(self):
        config = self.env['cleaning.ai.config'].create({
            'company_id': self.company.id, 'enabled': True, 'model': 'x'})
        with self.assertRaises(UserError):
            config._build_prompt()

    # ------------------------------------------------------------------
    # Writing the result back
    # ------------------------------------------------------------------
    def test_a_failed_review_never_leaves_a_stale_score(self):
        config = self._ai_config()
        recording = self._recording()
        recording.sudo().write({
            'ai_status': 'done', 'ai_score': 90, 'ai_summary': 'Looked spotless'})

        recording._ai_record_failure('The service was unreachable', config)

        self.assertEqual(recording.ai_status, 'failed')
        self.assertEqual(recording.ai_score, 0)
        self.assertFalse(recording.ai_summary)
        self.assertIn('unreachable', recording.ai_error)

    def test_results_are_written_from_the_parsed_reply(self):
        config = self._ai_config()
        recording = self._recording()
        checks = config.check_ids
        parsed = {
            'score': 72,
            'summary': 'Mostly clean, bin not emptied.',
            'issues': ['Bin by the door is full', 'Dust on the sill'],
            'checks': [
                {'id': checks[0].id, 'passed': True, 'note': 'Floor looks swept'},
                {'id': checks[1].id, 'passed': False, 'note': 'Bin is full'},
                {'id': checks[2].id, 'passed': None, 'note': 'Too dark to tell'},
            ],
        }
        recording._ai_apply_result(parsed, '{"raw": true}', config)

        self.assertEqual(recording.ai_status, 'done')
        self.assertEqual(recording.ai_score, 72)
        self.assertIn('Bin by the door is full', recording.ai_issues)

        results = {r.name: r.passed for r in recording.ai_result_ids}
        self.assertEqual(results[checks[0].name], 'yes')
        self.assertEqual(results[checks[1].name], 'no')
        # null has to mean "cannot tell". Treating it as a failure would turn a
        # dark photograph into a black mark against somebody.
        self.assertEqual(results[checks[2].name], 'unclear')

    def test_check_names_are_copied_so_history_stays_readable(self):
        config = self._ai_config()
        recording = self._recording()
        check = config.check_ids[0]
        original_name = check.name
        recording._ai_apply_result(
            {'score': 50, 'checks': [{'id': check.id, 'passed': True}]},
            'x', config)

        check.name = 'Completely different wording'
        result = recording.ai_result_ids[0]
        self.assertEqual(result.name, original_name,
                         "editing a check must not rewrite past reviews")

    def test_a_nonsense_score_is_clamped_not_trusted(self):
        config = self._ai_config()
        recording = self._recording()
        for given, expected in ((999, 100), (-5, 0), ('not a number', 0), (None, 0)):
            recording._ai_apply_result({'score': given, 'checks': []}, 'x', config)
            self.assertEqual(recording.ai_score, expected)

    # ------------------------------------------------------------------
    # Provider payloads, without a network
    # ------------------------------------------------------------------
    def _capture_post(self, reply):
        captured = {}

        def fake_post(url, payload, timeout, headers=None):
            captured['url'] = url
            captured['payload'] = payload
            captured['headers'] = headers or {}
            return reply

        return captured, fake_post

    def test_gemini_payload_carries_the_pictures_and_hides_the_key(self):
        captured, fake_post = self._capture_post(
            {'candidates': [{'content': {'parts': [{'text': '{"score": 1}'}]}}]})

        original = ai_provider._post
        ai_provider._post = fake_post
        try:
            _raw, parsed = ai_provider.analyse(
                {'provider': 'gemini', 'base_url': '', 'api_key': 'k',
                 'model': 'gemini-2.5-flash', 'max_output_tokens': 100,
                 'timeout': 10},
                'look at this',
                [{'mimetype': 'image/jpeg', 'data': b'aaaa'}])
        finally:
            ai_provider._post = original

        self.assertEqual(parsed, {'score': 1})
        self.assertIn('gemini-2.5-flash:generateContent', captured['url'])
        parts = captured['payload']['contents'][0]['parts']
        self.assertEqual(parts[0]['text'], 'look at this')
        self.assertEqual(parts[1]['inline_data']['mime_type'], 'image/jpeg')
        # The key goes in a header, never the query string, so it stays out of
        # proxy and web server access logs.
        self.assertEqual(captured['headers'].get('x-goog-api-key'), 'k')
        self.assertNotIn('key=', captured['url'])

    def test_ollama_payload_uses_the_configured_base_url(self):
        captured, fake_post = self._capture_post(
            {'message': {'content': '{"score": 2}'}})

        original = ai_provider._post
        ai_provider._post = fake_post
        try:
            _raw, parsed = ai_provider.analyse(
                {'provider': 'ollama', 'base_url': 'http://localhost:11434/',
                 'api_key': '', 'model': 'llama3.2-vision',
                 'max_output_tokens': 100, 'timeout': 10},
                'look at this',
                [{'mimetype': 'image/jpeg', 'data': b'aaaa'}])
        finally:
            ai_provider._post = original

        self.assertEqual(parsed, {'score': 2})
        # The trailing slash on the base URL must not produce a double slash.
        self.assertEqual(captured['url'], 'http://localhost:11434/api/chat')
        self.assertEqual(len(captured['payload']['messages'][0]['images']), 1)
        # A bare Ollama needs no auth; sending an empty bearer would be worse
        # than sending nothing.
        self.assertNotIn('Authorization', captured['headers'])

    def test_ollama_without_a_base_url_says_what_is_missing(self):
        with self.assertRaises(ai_provider.AiError) as caught:
            ai_provider.analyse(
                {'provider': 'ollama', 'base_url': '', 'api_key': '',
                 'model': 'llama3.2-vision', 'max_output_tokens': 100,
                 'timeout': 10},
                'x', [])
        self.assertIn('Base URL', str(caught.exception))

    def test_gemini_without_a_key_says_what_is_missing(self):
        with self.assertRaises(ai_provider.AiError) as caught:
            ai_provider.analyse(
                {'provider': 'gemini', 'base_url': '', 'api_key': '',
                 'model': 'gemini-2.5-flash', 'max_output_tokens': 100,
                 'timeout': 10},
                'x', [])
        self.assertIn('API key', str(caught.exception))

    # ------------------------------------------------------------------
    # Wiring
    # ------------------------------------------------------------------
    def test_pictures_are_only_captured_when_ai_is_switched_on(self):
        """No AI, no stills - people who do not use this upload nothing extra."""
        self.assertEqual(self.config._ai_frames_wanted(), 0)
        ai_config = self._ai_config()
        self.assertEqual(self.config._ai_frames_wanted(), 3)
        ai_config.enabled = False
        self.assertEqual(self.config._ai_frames_wanted(), 0)

    def test_analysing_without_pictures_explains_why(self):
        self._ai_config()
        recording = self._recording()
        with self.assertRaises(UserError) as caught:
            recording.action_ai_analyse()
        self.assertIn('no pictures', str(caught.exception).lower())

    def test_analysing_with_ai_switched_off_is_refused(self):
        self._ai_config(enabled=False)
        recording = self._recording()
        with self.assertRaises(UserError) as caught:
            recording.action_ai_analyse()
        self.assertIn('switched off', str(caught.exception).lower())

    def test_frames_are_stored_against_the_recording(self):
        recording = self._recording()
        recording._store_frames([(b'x' * 100, 'image/jpeg'),
                                 (b'y' * 100, 'image/jpeg')])
        self.assertEqual(recording.frame_count, 2)
        names = recording._frame_attachments().mapped('name')
        # Zero-padded so ten frames still sort into the right order.
        self.assertEqual(names, ['frame_01.jpg', 'frame_02.jpg'])
