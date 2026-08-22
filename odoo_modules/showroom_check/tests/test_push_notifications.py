import base64
import io
from datetime import datetime
from unittest.mock import patch

from PIL import Image

from odoo.tests.common import TransactionCase, tagged
from odoo.tools import mute_logger

from ..models import cleaning_push_provider as provider


@tagged('post_install', '-at_install')
class TestPushNotifications(TransactionCase):
    """Telling a manager that a round came in low.

    Everything here mocks the network. What is being tested is which rounds
    count as low, who hears about it, and that none of it can take a round
    down - not whether Firebase is reachable.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # An isolated company, for the same reason the main suite uses one:
        # tests have no business touching real records.
        cls.company = cls.env['res.company'].create({'name': 'Push Test Co'})
        cls.env.user.company_ids = [(4, cls.company.id)]
        cls.env = cls.env(context=dict(
            cls.env.context, allowed_company_ids=[cls.company.id]))

        cls.config = cls.env['cleaning.config'].create({
            'company_id': cls.company.id,
            'timezone': 'Asia/Kolkata',
            'notify_low_match': True,
            'notify_threshold': 60,
        })
        cls.slot = cls.env['cleaning.slot'].create({
            'config_id': cls.config.id,
            'name': 'Morning Round',
            'day_period': 'morning',
            'hour_from': 9.0,
            'hour_to': 10.0,
            'mon': True, 'tue': True, 'wed': True, 'thu': True,
            'fri': True, 'sat': True, 'sun': True,
        })
        cls.push = cls.env['cleaning.push.config'].create({
            'company_id': cls.company.id,
            'enabled': True,
            'project_id': 'test-project',
            'service_account_key': '{"client_email": "a@b.com", '
                                   '"private_key": "not-a-real-key"}',
        })

        cls.cleaner = cls.env['res.users'].create({
            'name': 'Push Test Cleaner',
            'login': 'push_test_cleaner',
            'company_id': cls.company.id,
            'company_ids': [(6, 0, [cls.company.id])],
            'group_ids': [(4, cls.env.ref(
                'showroom_check.group_cleaning_user').id)],
        })
        cls.manager = cls.env['res.users'].create({
            'name': 'Push Test Manager',
            'login': 'push_test_manager',
            'company_id': cls.company.id,
            'company_ids': [(6, 0, [cls.company.id])],
            'group_ids': [(4, cls.env.ref(
                'showroom_check.group_cleaning_manager').id)],
        })
        cls.device = cls.env['cleaning.push.device'].create({
            'user_id': cls.manager.id,
            'token': 'device-token-1',
            'platform': 'android',
            'company_id': cls.company.id,
        })

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _jpeg(self, seed=0):
        image = Image.new('RGB', (64, 64))
        pixels = image.load()
        for x in range(64):
            for y in range(64):
                pixels[x, y] = ((x * 3 + seed) % 256, (y * 5) % 256,
                                (x + y + seed) % 256)
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=95)
        return buffer.getvalue()

    def _round(self, score, day=17, approximate=False):
        """A stored, scored round sitting at exactly `score`.

        Built through _store_direction_shots rather than by hand, so the stored
        aggregates are computed the way a real upload computes them - which is
        the whole thing being tested.
        """
        reference = self.config.reference_image_ids.filtered(
            lambda r: r.direction == 'front')
        reference.write({'image': base64.b64encode(self._jpeg())})

        started = datetime(2026, 8, day, 3, 40)
        recording = self.env['cleaning.recording'].create({
            'slot_id': self.slot.id,
            'slot_date': self.config._local_date(started),
            'user_id': self.cleaner.id,
            'started_at': started,
        })
        recording._store_direction_shots([
            ('front', self._jpeg(), 'image/jpeg', 'front.jpg'),
        ])
        values = {'match_score': score}
        if approximate:
            # score_approximate is "feature matching ran and could not line the
            # two up". That is what makes _compute_match leave the round with
            # no worst view at all.
            values.update({'same_view': 'yes', 'registered': False})
        recording.shot_ids.write(values)
        recording.invalidate_recordset()
        return recording

    def _sent(self):
        """Patch the two network calls and collect what would have gone out."""
        calls = []

        def fake_send(project, token, device_token, title, body, data=None,
                      timeout=None):
            calls.append({
                'project': project, 'device_token': device_token,
                'title': title, 'body': body, 'data': data,
            })
            return {'ok': True, 'dead': False, 'error': None}

        return calls, patch.object(provider, 'send', fake_send), \
            patch.object(provider, 'access_token', lambda *a, **k: 'token')

    # ------------------------------------------------------------------
    # Which rounds count
    # ------------------------------------------------------------------
    def test_a_round_below_the_level_is_low(self):
        self.assertTrue(self._round(45)._is_low_match())

    def test_a_round_above_the_level_is_not(self):
        self.assertFalse(self._round(75)._is_low_match())

    def test_the_level_is_exclusive(self):
        """Exactly at the threshold is not below it."""
        self.assertFalse(self._round(60)._is_low_match())

    def test_a_round_nothing_could_be_measured_on_is_not_low(self):
        """The one that matters most.

        _compute_match leaves match_score at 0 when not one view could be
        lined up - so a round with a broken camera, or an original nobody has
        set up, looks identical to a total failure if only the number is read.
        Without the match_worst_label guard this notifies every manager that a
        showroom scored 0%, about a round nobody can act on.
        """
        recording = self._round(0, approximate=True)
        self.assertEqual(recording.match_score, 0)
        self.assertFalse(recording.match_worst_label)
        self.assertFalse(recording._is_low_match())

    def test_turning_notifications_off_makes_nothing_low(self):
        recording = self._round(45)
        self.config.notify_low_match = False
        self.assertFalse(recording._is_low_match())

    def test_moving_the_level_re_derives_the_history(self):
        """No stored rows to go stale: the list is a search.

        A round that was fine yesterday is low today if the number moves, and
        nothing had to be rewritten for that to be true.
        """
        recording = self._round(70)
        self.assertFalse(recording._is_low_match())
        self.config.notify_threshold = 80
        self.assertTrue(recording._is_low_match())

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------
    def test_a_low_round_notifies_the_manager(self):
        recording = self._round(45)
        calls, send_patch, token_patch = self._sent()
        with send_patch, token_patch:
            recording._notify_low_match()

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['device_token'], 'device-token-1')
        self.assertEqual(calls[0]['data']['recordingId'], recording.id)
        self.assertIn('45', calls[0]['body'])
        self.assertTrue(recording.low_match_notified_at)

    def test_a_good_round_notifies_nobody(self):
        recording = self._round(85)
        calls, send_patch, token_patch = self._sent()
        with send_patch, token_patch:
            recording._notify_low_match()
        self.assertEqual(calls, [])
        self.assertFalse(recording.low_match_notified_at)

    def test_the_same_round_is_never_notified_twice(self):
        """A re-score must not tell everybody again."""
        recording = self._round(45)
        calls, send_patch, token_patch = self._sent()
        with send_patch, token_patch:
            recording._notify_low_match()
            recording._notify_low_match()
        self.assertEqual(len(calls), 1)

    def test_a_round_is_stamped_even_when_push_is_off(self):
        """Otherwise switching push on next month floods every manager.

        The stamp says "this round has been dealt with", not "a message was
        delivered". Leaving it empty while push is off would mean every old low
        round in the database queues up behind the switch.
        """
        self.push.enabled = False
        recording = self._round(45)
        calls, send_patch, token_patch = self._sent()
        with send_patch, token_patch:
            recording._notify_low_match()
        self.assertEqual(calls, [])
        self.assertTrue(recording.low_match_notified_at)

    @mute_logger('odoo.addons.showroom_check.models.cleaning_recording')
    def test_a_round_survives_firebase_being_broken(self):
        """The contract. A notification that cannot go out is a nuisance;
        losing somebody's round because Google was unreachable is not."""
        recording = self._round(45)

        def explode(*args, **kwargs):
            raise provider.PushError("no")

        with patch.object(provider, 'access_token', explode):
            recording._notify_low_match()

        self.assertTrue(recording.exists())
        self.assertEqual(recording.match_score, 45)

    @mute_logger('odoo.addons.showroom_check.models.cleaning_push_config')
    def test_a_phone_firebase_says_is_gone_is_removed(self):
        recording = self._round(45)

        def dead(*args, **kwargs):
            return {'ok': False, 'dead': True, 'error': 'UNREGISTERED'}

        with patch.object(provider, 'send', dead), \
                patch.object(provider, 'access_token', lambda *a, **k: 't'):
            recording._notify_low_match()

        self.assertFalse(self.device.exists(),
                         "a token Firebase reports as gone must not be kept")

    # ------------------------------------------------------------------
    # The in-app list
    # ------------------------------------------------------------------
    def test_the_feed_lists_low_rounds_for_a_manager(self):
        recording = self._round(45)
        feed = self.env['cleaning.recording'].with_user(
            self.manager).notification_feed()
        self.assertTrue(feed['is_manager'])
        self.assertEqual(feed['threshold'], 60)
        self.assertEqual([r['id'] for r in feed['rows']], [recording.id])
        self.assertEqual(feed['unread_count'], 1)

    def test_the_feed_tells_a_plain_user_nothing(self):
        """The refusal is the server's, not the interface's.

        A chip that is not drawn is not access control - this is reachable over
        call_kw by anybody holding a session.
        """
        self._round(45)
        feed = self.env['cleaning.recording'].with_user(
            self.cleaner).notification_feed()
        self.assertFalse(feed['is_manager'])
        self.assertEqual(feed['rows'], [])
        self.assertEqual(feed['unread_count'], 0)

    def test_the_badge_is_zero_for_a_plain_user(self):
        """Not hidden - never sent. How many rounds scored badly does not leak
        to the people being measured, even as a number."""
        self._round(45)
        state = self.env['cleaning.config'].with_user(
            self.cleaner).get_dashboard_state()
        self.assertEqual(state['low_match_unread'], 0)

    def test_the_badge_counts_for_a_manager(self):
        self._round(45)
        state = self.env['cleaning.config'].with_user(
            self.manager).get_dashboard_state()
        self.assertEqual(state['low_match_unread'], 1)

    def test_marking_seen_clears_the_badge(self):
        self._round(45)
        Recording = self.env['cleaning.recording'].with_user(self.manager)
        self.assertEqual(Recording.notification_feed()['unread_count'], 1)

        Recording.mark_notifications_seen()
        self.assertEqual(Recording.notification_feed()['unread_count'], 0)
        # Still listed - read, not gone.
        self.assertEqual(len(Recording.notification_feed()['rows']), 1)

    def test_a_later_round_raises_the_count_again(self):
        self._round(45, day=17)
        Recording = self.env['cleaning.recording'].with_user(self.manager)
        Recording.mark_notifications_seen()
        self.assertEqual(Recording.notification_feed()['unread_count'], 0)

        self._round(30, day=18)
        self.assertEqual(Recording.notification_feed()['unread_count'], 1)

    def test_a_plain_user_cannot_mark_anything_seen(self):
        self.assertFalse(self.env['cleaning.recording'].with_user(
            self.cleaner).mark_notifications_seen())

    # ------------------------------------------------------------------
    # Registering a phone
    # ------------------------------------------------------------------
    def test_a_manager_can_register_a_phone(self):
        Device = self.env['cleaning.push.device'].with_user(self.manager)
        self.assertTrue(Device.register_device('new-token'))
        self.assertTrue(self.env['cleaning.push.device'].sudo().search([
            ('token', '=', 'new-token'),
            ('user_id', '=', self.manager.id),
        ]))

    def test_a_plain_user_registers_nothing(self):
        """Only managers are ever notified, so only their phones are worth
        keeping the address of."""
        Device = self.env['cleaning.push.device'].with_user(self.cleaner)
        self.assertFalse(Device.register_device('user-token'))
        self.assertFalse(self.env['cleaning.push.device'].sudo().search([
            ('token', '=', 'user-token')]))

    def test_a_shared_phone_moves_to_whoever_signed_in(self):
        """Otherwise it keeps notifying whoever used it last week."""
        second = self.env['res.users'].create({
            'name': 'Second Manager',
            'login': 'push_test_manager_2',
            'company_id': self.company.id,
            'company_ids': [(6, 0, [self.company.id])],
            'group_ids': [(4, self.env.ref(
                'showroom_check.group_cleaning_manager').id)],
        })
        self.env['cleaning.push.device'].with_user(second).register_device(
            'device-token-1')

        self.device.invalidate_recordset()
        self.assertEqual(self.device.user_id, second)
        self.assertEqual(self.env['cleaning.push.device'].sudo().search_count(
            [('token', '=', 'device-token-1')]), 1)

    def test_signing_out_forgets_the_phone(self):
        Device = self.env['cleaning.push.device'].with_user(self.manager)
        Device.unregister_device('device-token-1')
        self.assertFalse(self.device.exists())

    def test_only_your_own_phones_are_visible(self):
        """A device token is the address a phone is reachable at. A colleague
        holding the manager role has no business reading it."""
        second = self.env['res.users'].create({
            'name': 'Nosy Manager',
            'login': 'push_test_manager_3',
            'company_id': self.company.id,
            'company_ids': [(6, 0, [self.company.id])],
            'group_ids': [(4, self.env.ref(
                'showroom_check.group_cleaning_manager').id)],
        })
        visible = self.env['cleaning.push.device'].with_user(second).search([])
        self.assertNotIn(self.device, visible)

    # ------------------------------------------------------------------
    # The message itself
    # ------------------------------------------------------------------
    def test_the_message_carries_a_notification_block(self):
        """Data-only would not be drawn while the app is closed, which is
        exactly when somebody needs telling."""
        message = provider.build_message(
            'tok', 'Title', 'Body', {'recordingId': 7})['message']
        self.assertEqual(message['notification']['title'], 'Title')
        self.assertEqual(message['android']['priority'], 'high')
        self.assertEqual(
            message['android']['notification']['channel_id'],
            provider.CHANNEL_ID)

    def test_the_data_payload_is_all_strings(self):
        """FCM rejects a number in `data` with a flat 400 that says nothing
        about which key was at fault."""
        message = provider.build_message(
            'tok', 'T', 'B', {'recordingId': 7})['message']
        self.assertEqual(message['data']['recordingId'], '7')

    def test_the_title_and_body_are_not_repeated_in_data(self):
        """Sending them in both places draws the notification twice."""
        message = provider.build_message('tok', 'T', 'B', {})['message']
        self.assertNotIn('title', message['data'])
        self.assertNotIn('body', message['data'])
