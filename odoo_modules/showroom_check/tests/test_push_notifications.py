import base64
import io
from datetime import datetime, timedelta
from unittest.mock import patch

from PIL import Image

from odoo import fields
from odoo.tests.common import TransactionCase, tagged
from odoo.tools import mute_logger

from ..models import cleaning_push_provider as provider


@tagged('post_install', '-at_install')
class TestPushNotifications(TransactionCase):
    """Telling a manager that a round came in low.

    Everything here mocks the network. What is being tested is which rounds
    count as low, who hears about it, how a batch is split, and that none of it
    can take a round down - not whether Expo is reachable.
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
        # No credential: on the Expo path the Firebase key lives in EAS.
        cls.push = cls.env['cleaning.push.config'].create({
            'company_id': cls.company.id,
            'enabled': True,
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
            'token': 'ExponentPushToken[device-one]',
            'platform': 'android',
            'project_id': 'project-a',
            'company_id': cls.company.id,
        })

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _jpeg(self, seed=0):
        """A real JPEG, comfortably over MIN_PHOTO_BYTES.

        320x240 and full of noise, exactly as the main suite's _jpeg is and for
        the same reason: _store_direction_shots silently DROPS anything under
        the 2048-byte floor, so a smaller picture produces a round with no
        shots at all and every assertion here fails for a reason that has
        nothing to do with notifications.
        """
        image = Image.new('RGB', (320, 240))
        pixels = image.load()
        for x in range(320):
            for y in range(240):
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
        self.assertTrue(
            recording.shot_ids,
            "the test photograph was dropped - check it clears "
            "MIN_PHOTO_BYTES")
        recording.shot_ids.write(values)
        recording.invalidate_recordset()
        return recording

    def _sent(self, retire=None, config=None):
        """Intercept the Expo batches and record what would have gone out.

        Returns (batches, patcher). One entry per REQUEST rather than per
        message, which is what lets the mixed-project test assert that two
        projects cost two requests rather than one.
        """
        batches = []

        def fake_batch(messages, timeout=None):
            batches.append(messages)
            tokens = [m['to'] for m in messages]
            dead = [t for t in tokens if t in (retire or [])]
            return {
                'sent': len(tokens) - len(dead),
                'retire': dead,
                'config': config,
            }

        return batches, patch.object(provider, 'send_batch', fake_batch)

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
        batches, sending = self._sent()
        with sending:
            recording._notify_low_match()

        self.assertEqual(len(batches), 1)
        message = batches[0][0]
        self.assertEqual(message['to'], 'ExponentPushToken[device-one]')
        self.assertEqual(message['data']['recordingId'], recording.id)
        self.assertEqual(message['channelId'], provider.CHANNEL_ID)
        self.assertIn('45', message['body'])
        self.assertTrue(recording.low_match_notified_at)

    def test_a_good_round_notifies_nobody(self):
        recording = self._round(85)
        batches, sending = self._sent()
        with sending:
            recording._notify_low_match()
        self.assertEqual(batches, [])
        self.assertFalse(recording.low_match_notified_at)

    def test_the_same_round_is_never_notified_twice(self):
        """A re-score must not tell everybody again."""
        recording = self._round(45)
        batches, sending = self._sent()
        with sending:
            recording._notify_low_match()
            recording._notify_low_match()
        self.assertEqual(len(batches), 1)

    def test_two_projects_are_sent_as_two_requests(self):
        """The lesson kra_kpi_module learned the hard way.

        Expo rejects a request whose messages span two EAS projects, and
        rejects the WHOLE request - so one token left behind by an older
        project would take every other manager's notification with it. They
        have to go as separate requests.
        """
        second = self.env['res.users'].create({
            'name': 'Other Manager',
            'login': 'push_test_manager_other',
            'company_id': self.company.id,
            'company_ids': [(6, 0, [self.company.id])],
            'group_ids': [(4, self.env.ref(
                'showroom_check.group_cleaning_manager').id)],
        })
        self.env['cleaning.push.device'].create({
            'user_id': second.id,
            'token': 'ExponentPushToken[device-two]',
            'platform': 'android',
            'project_id': 'project-b',
            'company_id': self.company.id,
        })

        recording = self._round(45)
        batches, sending = self._sent()
        with sending:
            recording._notify_low_match()

        self.assertEqual(
            len(batches), 2,
            "two EAS projects must not share one Expo request")
        for batch in batches:
            projects = {
                self.env['cleaning.push.device'].search(
                    [('token', '=', m['to'])]).project_id
                for m in batch
            }
            self.assertEqual(len(projects), 1,
                             "a batch mixed two projects")

    def test_a_round_is_stamped_even_when_push_is_off(self):
        """Otherwise switching push on next month floods every manager.

        The stamp says "this round has been dealt with", not "a message was
        delivered". Leaving it empty while push is off would mean every old low
        round in the database queues up behind the switch.
        """
        self.push.enabled = False
        recording = self._round(45)
        batches, sending = self._sent()
        with sending:
            recording._notify_low_match()
        self.assertEqual(batches, [])
        self.assertTrue(recording.low_match_notified_at)

    @mute_logger('odoo.addons.showroom_check.models.cleaning_recording')
    def test_a_round_survives_expo_being_broken(self):
        """The contract. A notification that cannot go out is a nuisance;
        losing somebody's round because Expo was unreachable is not."""
        recording = self._round(45)

        def explode(*args, **kwargs):
            raise provider.PushError("no")

        with patch.object(provider, 'send_batch', explode):
            recording._notify_low_match()

        self.assertTrue(recording.exists())
        self.assertEqual(recording.match_score, 45)

    @mute_logger('odoo.addons.showroom_check.models.cleaning_push_config')
    def test_a_phone_expo_says_is_gone_is_retired(self):
        """Retired, not deleted: the row is a record that it existed."""
        recording = self._round(45)
        _batches, sending = self._sent(
            retire=['ExponentPushToken[device-one]'])
        with sending:
            recording._notify_low_match()

        self.device.invalidate_recordset()
        self.assertFalse(self.device.active,
                         "a token Expo reports as gone must be retired")
        self.assertTrue(
            self.device.with_context(active_test=False).exists(),
            "and the row must survive rather than be deleted")

    def test_signing_in_again_un_retires_a_phone(self):
        """The token was just minted, so it is demonstrably alive."""
        self.device.active = False
        self.env['cleaning.push.device'].with_user(
            self.manager).register_device(
                'ExponentPushToken[device-one]', 'android')
        self.device.invalidate_recordset()
        self.assertTrue(self.device.active)

    # ------------------------------------------------------------------
    # The provider's own reading of Expo's answer
    # ------------------------------------------------------------------
    def test_a_body_too_long_for_a_banner_is_trimmed(self):
        long_body = 'x' * 400
        message = provider.build_message('tok', 'Title', long_body)
        self.assertLessEqual(len(message['body']), provider.MAX_BODY_CHARS)
        self.assertTrue(message['body'].endswith('...'))

    def test_a_short_body_is_left_alone(self):
        self.assertEqual(
            provider.build_message('tok', 'T', 'Just so')['body'], 'Just so')

    def test_the_message_carries_the_channel_and_high_priority(self):
        message = provider.build_message('tok', 'T', 'B', {'recordingId': 7})
        self.assertEqual(message['channelId'], provider.CHANNEL_ID)
        self.assertEqual(message['priority'], 'high')
        self.assertEqual(message['data']['recordingId'], 7)

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

    def test_marking_one_read_clears_it_from_the_count(self):
        rec = self._round(45)
        Recording = self.env['cleaning.recording'].with_user(self.manager)
        self.assertEqual(Recording.notification_feed()['unread_count'], 1)

        Recording.mark_notification_read([rec.id])
        feed = Recording.notification_feed()
        self.assertEqual(feed['unread_count'], 0)
        self.assertEqual(feed['read_count'], 1)
        # Still listed under All - read, not gone.
        self.assertEqual(len(feed['rows']), 1)
        self.assertFalse(feed['rows'][0]['is_unread'])

    def test_a_round_can_be_marked_unread_again(self):
        """A bell that can only be emptied is one people stop trusting."""
        rec = self._round(45)
        Recording = self.env['cleaning.recording'].with_user(self.manager)
        Recording.mark_notification_read([rec.id])
        self.assertEqual(Recording.notification_feed()['unread_count'], 0)

        Recording.mark_notification_read([rec.id], read=False)
        self.assertEqual(Recording.notification_feed()['unread_count'], 1)

    def test_the_filters_split_the_list(self):
        first = self._round(45, day=17)
        self._round(30, day=18)
        Recording = self.env['cleaning.recording'].with_user(self.manager)
        Recording.mark_notification_read([first.id])

        self.assertEqual(len(Recording.notification_feed(only='all')['rows']), 2)
        unread = Recording.notification_feed(only='unread')['rows']
        read = Recording.notification_feed(only='read')['rows']
        self.assertEqual([r['id'] for r in read], [first.id])
        self.assertNotIn(first.id, [r['id'] for r in unread])
        self.assertEqual(len(unread), 1)

    def test_mark_all_empties_the_bell(self):
        self._round(45, day=17)
        self._round(30, day=18)
        Recording = self.env['cleaning.recording'].with_user(self.manager)
        self.assertEqual(Recording.notification_feed()['unread_count'], 2)

        Recording.mark_all_notifications_read()
        feed = Recording.notification_feed()
        self.assertEqual(feed['unread_count'], 0)
        self.assertEqual(feed['read_count'], 2)

    def test_read_state_is_per_user(self):
        """One manager reading it must not clear it for another."""
        other = self.env['res.users'].create({
            'name': 'Second Reader', 'login': 'push_reader_2',
            'company_id': self.company.id,
            'company_ids': [(6, 0, [self.company.id])],
            'group_ids': [(4, self.env.ref(
                'showroom_check.group_cleaning_manager').id)],
        })
        rec = self._round(45)
        Recording = self.env['cleaning.recording']
        Recording.with_user(self.manager).mark_notification_read([rec.id])
        self.assertEqual(Recording.with_user(
            self.manager).notification_feed()['unread_count'], 0)
        self.assertEqual(Recording.with_user(
            other).notification_feed()['unread_count'], 1)

    def test_a_plain_user_cannot_mark_anything_read(self):
        rec = self._round(45)
        self.assertFalse(self.env['cleaning.recording'].with_user(
            self.cleaner).mark_notification_read([rec.id]))
        self.assertFalse(self.env['cleaning.recording'].with_user(
            self.cleaner).mark_all_notifications_read())

    # ------------------------------------------------------------------
    # Registering a phone
    # ------------------------------------------------------------------
    def test_a_manager_can_register_a_phone(self):
        Device = self.env['cleaning.push.device'].with_user(self.manager)
        self.assertTrue(Device.register_device(
            'ExponentPushToken[new]', 'android',
            device='Galaxy Tab A', project_id='project-a'))
        row = self.env['cleaning.push.device'].sudo().search([
            ('token', '=', 'ExponentPushToken[new]')])
        self.assertEqual(row.user_id, self.manager)
        self.assertEqual(row.device, 'Galaxy Tab A')
        self.assertEqual(row.project_id, 'project-a')

    def test_a_plain_user_registers_nothing(self):
        """Only managers are ever notified, so only their phones are worth
        keeping the address of."""
        Device = self.env['cleaning.push.device'].with_user(self.cleaner)
        self.assertFalse(Device.register_device('ExponentPushToken[user]'))
        self.assertFalse(self.env['cleaning.push.device'].sudo().search([
            ('token', '=', 'ExponentPushToken[user]')]))

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
            'ExponentPushToken[device-one]')

        self.device.invalidate_recordset()
        self.assertEqual(self.device.user_id, second)
        self.assertEqual(self.env['cleaning.push.device'].sudo().search_count(
            [('token', '=', 'ExponentPushToken[device-one]')]), 1)

    def test_signing_out_forgets_the_phone(self):
        Device = self.env['cleaning.push.device'].with_user(self.manager)
        Device.unregister_device('ExponentPushToken[device-one]')
        self.assertFalse(
            self.device.with_context(active_test=False).exists())

    def test_only_your_own_phones_are_visible(self):
        """A push token is the address a phone is reachable at. A colleague
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

    def test_devices_group_by_project(self):
        devices = self.env['cleaning.push.device'].sudo().create([
            {'user_id': self.manager.id, 'token': 'ExponentPushToken[a1]',
             'project_id': 'p1', 'company_id': self.company.id},
            {'user_id': self.manager.id, 'token': 'ExponentPushToken[a2]',
             'project_id': 'p1', 'company_id': self.company.id},
            {'user_id': self.manager.id, 'token': 'ExponentPushToken[b1]',
             'project_id': 'p2', 'company_id': self.company.id},
        ])
        groups = devices._grouped_by_project()
        self.assertEqual(sorted(groups), ['p1', 'p2'])
        self.assertEqual(len(groups['p1']), 2)
        self.assertEqual(len(groups['p2']), 1)
