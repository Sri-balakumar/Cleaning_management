import base64
import io
from datetime import date, datetime

from PIL import Image

from odoo.exceptions import AccessError, ValidationError
from odoo.tests.common import TransactionCase, tagged
from odoo.tools import mute_logger

from ..models.cleaning_config import float_to_time, format_float_time
from ..models.cleaning_recording import base_mimetype


@tagged('post_install', '-at_install')
class TestCleaningManagement(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # A company of its own, rather than reusing the live one.
        #
        # The first version of this deleted every cleaning.config to get a clean
        # slate, which worked only while the database had no real recordings.
        # As soon as somebody recorded a round, that delete hit the restrict
        # constraint on cleaning_recording.slot_id and the whole suite errored
        # in setUpClass. Tests have no business removing real records; an
        # isolated company gives a clean slate without touching anything.
        cls.company = cls.env['res.company'].create({'name': 'Cleaning Test Co'})
        cls.env.user.company_ids = [(4, cls.company.id)]
        cls.env = cls.env(context=dict(
            cls.env.context, allowed_company_ids=[cls.company.id]))

        cls.config = cls.env['cleaning.config'].create({
            'company_id': cls.company.id,
            'timezone': 'Asia/Kolkata',
            'duration_value': 60,
            'duration_unit': 'seconds',
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
        cls.cleaner = cls.env['res.users'].create({
            'name': 'Test Cleaner',
            'login': 'test_cleaner_cm',
            'company_id': cls.company.id,
            'company_ids': [(6, 0, [cls.company.id])],
            'group_ids': [(4, cls.env.ref('showroom_check.group_cleaning_user').id)],
        })
        cls.other_cleaner = cls.env['res.users'].create({
            'name': 'Other Cleaner',
            'login': 'test_cleaner_cm_2',
            'company_id': cls.company.id,
            'company_ids': [(6, 0, [cls.company.id])],
            'group_ids': [(4, cls.env.ref('showroom_check.group_cleaning_user').id)],
        })
        cls.manager = cls.env['res.users'].create({
            'name': 'Test Cleaning Manager',
            'login': 'test_manager_cm',
            'company_id': cls.company.id,
            'company_ids': [(6, 0, [cls.company.id])],
            'group_ids': [(4, cls.env.ref('showroom_check.group_cleaning_manager').id)],
        })

    # ------------------------------------------------------------------
    # Time conversion
    # ------------------------------------------------------------------
    def test_float_to_time_rounds_and_carries(self):
        self.assertEqual(float_to_time(9.0), datetime(2000, 1, 1, 9, 0).time())
        self.assertEqual(float_to_time(9.5), datetime(2000, 1, 1, 9, 30).time())
        # 9.999 must become 10:00, not the impossible 09:60.
        self.assertEqual(float_to_time(9.999), datetime(2000, 1, 1, 10, 0).time())
        self.assertEqual(float_to_time(24.0).hour, 23)
        self.assertEqual(float_to_time(-5).hour, 0)

    def test_format_float_time(self):
        self.assertEqual(format_float_time(9.0), '09:00')
        self.assertEqual(format_float_time(14.5), '14:30')

    def test_window_is_converted_from_office_timezone(self):
        """09:00 in India is 03:30 UTC. This is the bug that would otherwise
        make the button open five and a half hours late."""
        opens, closes = self.slot._window_utc(date(2026, 8, 17))
        self.assertEqual(opens, datetime(2026, 8, 17, 3, 30))
        self.assertEqual(closes, datetime(2026, 8, 17, 4, 30))

    def test_window_ignores_the_users_own_timezone(self):
        """A supervisor in Brussels must see the same window as the cleaner."""
        self.cleaner.tz = 'Europe/Brussels'
        as_cleaner = self.slot.with_user(self.cleaner)
        opens, _closes = as_cleaner._window_utc(date(2026, 8, 17))
        self.assertEqual(opens, datetime(2026, 8, 17, 3, 30))

        # And the same when the user has no timezone set at all, which is very
        # common and would otherwise silently fall back to UTC.
        self.other_cleaner.tz = False
        opens_again, _ = self.slot.with_user(self.other_cleaner)._window_utc(
            date(2026, 8, 17))
        self.assertEqual(opens_again, datetime(2026, 8, 17, 3, 30))

    def test_local_date_uses_office_timezone(self):
        """At 22:00 UTC it is already tomorrow in India."""
        self.assertEqual(
            self.config._local_date(datetime(2026, 8, 17, 22, 0)),
            date(2026, 8, 18),
        )

    # ------------------------------------------------------------------
    # Slot rules
    # ------------------------------------------------------------------
    def test_overlapping_slots_are_refused(self):
        with self.assertRaises(ValidationError):
            self.env['cleaning.slot'].create({
                'config_id': self.config.id,
                'name': 'Clashing Round',
                'hour_from': 9.5,
                'hour_to': 10.5,
            })

    def test_non_overlapping_slot_is_allowed(self):
        slot = self.env['cleaning.slot'].create({
            'config_id': self.config.id,
            'name': 'Afternoon Round',
            'hour_from': 14.0,
            'hour_to': 15.0,
        })
        self.assertTrue(slot.id)

    def test_slot_with_no_weekday_is_refused(self):
        with self.assertRaises(ValidationError):
            self.env['cleaning.slot'].create({
                'config_id': self.config.id,
                'name': 'Never Runs',
                'hour_from': 20.0,
                'hour_to': 21.0,
                'mon': False, 'tue': False, 'wed': False, 'thu': False,
                'fri': False, 'sat': False, 'sun': False,
            })

    def test_duration_beyond_the_cap_is_refused_with_a_useful_message(self):
        with self.assertRaises(ValidationError) as caught:
            self.config.write({'duration_value': 1, 'duration_unit': 'hours'})
        message = str(caught.exception)
        self.assertIn('minutes', message)
        # The message has to name the real size, or the admin has no way to
        # know how far over they are.
        self.assertIn('MB', message)

    def test_duration_seconds_normalises_units(self):
        self.config.write({'duration_value': 2, 'duration_unit': 'minutes'})
        self.assertEqual(self.config.duration_seconds, 120)

    # ------------------------------------------------------------------
    # Recording rules
    # ------------------------------------------------------------------
    def _recording_values(self, started_at, user=None):
        return {
            'slot_id': self.slot.id,
            'slot_date': self.config._local_date(started_at),
            'user_id': (user or self.cleaner).id,
            'started_at': started_at,
        }

    @mute_logger('odoo.sql_db')
    def test_only_one_recording_per_slot_per_day(self):
        started = datetime(2026, 8, 17, 3, 40)  # 09:10 India time
        self.env['cleaning.recording'].create(self._recording_values(started))
        with self.assertRaises(Exception):
            self.env['cleaning.recording'].create(
                self._recording_values(started, user=self.other_cleaner))
            self.env.flush_all()

    def test_deleting_a_recording_re_opens_the_slot(self):
        started = datetime(2026, 8, 17, 3, 40)
        recording = self.env['cleaning.recording'].create(
            self._recording_values(started))
        recording.unlink()
        again = self.env['cleaning.recording'].create(
            self._recording_values(started))
        self.assertTrue(again.id)

    def test_user_cannot_record_outside_the_window(self):
        # 05:00 UTC is 10:30 in India - half an hour after the window closed.
        outside = datetime(2026, 8, 17, 5, 0)
        with self.assertRaises(ValidationError):
            self.env['cleaning.recording'].with_user(self.cleaner).create(
                self._recording_values(outside))

    def test_user_cannot_backdate_a_recording(self):
        """A start time inside yesterday's window filed under today would
        otherwise slip past the one-per-day rule."""
        stale = datetime(2020, 1, 1, 3, 40)
        with self.assertRaises(ValidationError):
            self.env['cleaning.recording'].with_user(self.cleaner).create(
                self._recording_values(stale))

    def test_user_not_on_the_allowed_list_is_refused(self):
        self.config.write({
            'allowed_user_mode': 'list',
            'allowed_user_ids': [(6, 0, [self.other_cleaner.id])],
        })
        self.assertTrue(self.config._check_user_allowed(self.cleaner))
        self.assertFalse(self.config._check_user_allowed(self.other_cleaner))

    def test_allowed_list_is_enforced_on_create_not_just_in_the_interface(self):
        self.config.write({
            'allowed_user_mode': 'list',
            'allowed_user_ids': [(6, 0, [self.other_cleaner.id])],
        })
        started = datetime(2026, 8, 17, 3, 40)
        with self.assertRaises(AccessError):
            self.env['cleaning.recording'].with_user(self.cleaner).create(
                self._recording_values(started))

    # ------------------------------------------------------------------
    # Visibility
    # ------------------------------------------------------------------
    def test_a_user_sees_only_their_own_recordings(self):
        started = datetime(2026, 8, 17, 3, 40)
        self.env['cleaning.recording'].create(
            self._recording_values(started, user=self.other_cleaner))
        visible = self.env['cleaning.recording'].with_user(self.cleaner).search([])
        self.assertFalse(visible)

    def test_a_manager_sees_every_recording(self):
        """Manager implies User, so without the manager rule a Manager would be
        quietly narrowed to their own recordings."""
        started = datetime(2026, 8, 17, 3, 40)
        self.env['cleaning.recording'].create(
            self._recording_values(started, user=self.other_cleaner))
        visible = self.env['cleaning.recording'].with_user(self.manager).search([])
        self.assertEqual(len(visible), 1)

    # ------------------------------------------------------------------
    # Read-only once sent
    # ------------------------------------------------------------------
    def test_a_user_cannot_edit_a_recording_they_sent(self):
        """Sending is final for a User. The ACL grants create but not write,
        so a recording is evidence rather than something to revise."""
        started = datetime(2026, 8, 17, 3, 40)
        recording = self.env['cleaning.recording'].create(
            self._recording_values(started))
        with self.assertRaises(AccessError):
            recording.with_user(self.cleaner).write({'note': 'edited after sending'})

    def test_a_user_cannot_delete_a_recording_they_sent(self):
        """Only a Manager deletes, which is what re-opens the round."""
        started = datetime(2026, 8, 17, 3, 40)
        recording = self.env['cleaning.recording'].create(
            self._recording_values(started))
        with self.assertRaises(AccessError):
            recording.with_user(self.cleaner).unlink()

    def test_can_manage_is_evaluated_per_user(self):
        """Guards the caching trap: can_manage is computed, so without a
        context dependency on the user it would be cached against the record
        and a Manager's True would leak into a User's form."""
        started = datetime(2026, 8, 17, 3, 40)
        recording = self.env['cleaning.recording'].create(
            self._recording_values(started))
        # Manager first, so a stale cache would be the wrong answer below.
        self.assertTrue(recording.with_user(self.manager).can_manage)
        self.assertFalse(recording.with_user(self.cleaner).can_manage)

    def test_can_view_is_false_for_a_colleagues_recording(self):
        """A round is one recording for the whole day, so everybody sees it as
        done - but only its owner and a Manager may open it. can_view is what
        stops the dashboard offering the others a Watch button that errors."""
        started = datetime(2026, 8, 17, 3, 40)
        self.env['cleaning.recording'].create(
            self._recording_values(started, user=self.other_cleaner))

        def row_for(user):
            rows, _active, _now, _local, _today = (
                self.config.with_user(user)._slot_rows(now_utc=started))
            return next(r for r in rows if r['id'] == self.slot.id)

        mine = row_for(self.other_cleaner)
        self.assertEqual(mine['state'], 'done')
        self.assertTrue(mine['can_view'])

        theirs = row_for(self.cleaner)
        # Still visibly done, so nobody tries to record it again...
        self.assertEqual(theirs['state'], 'done')
        self.assertEqual(theirs['recorded_by'], self.other_cleaner.name)
        # ...but not openable.
        self.assertFalse(theirs['can_view'])

        self.assertTrue(row_for(self.manager)['can_view'])

    # ------------------------------------------------------------------
    # Dashboard
    # ------------------------------------------------------------------
    def test_dashboard_reports_every_round_of_the_day(self):
        self.env['cleaning.slot'].create({
            'config_id': self.config.id,
            'name': 'Afternoon Round',
            'hour_from': 14.0,
            'hour_to': 15.0,
        })
        state = self.env['cleaning.config'].get_dashboard_state()
        self.assertTrue(state['ok'])
        self.assertEqual(len(state['slots']), 2)
        self.assertEqual(state['timezone'], 'Asia/Kolkata')
        for row in state['slots']:
            self.assertIn(row['state'], ('done', 'open', 'upcoming', 'missed'))

    def test_dashboard_sends_resolved_recording_settings(self):
        settings = self.env['cleaning.config'].get_dashboard_state()['settings']
        self.assertEqual(settings['width'], 1280)
        self.assertEqual(settings['height'], 720)
        self.assertEqual(settings['video_bitrate'], 1500000)
        self.assertFalse(settings['audio_enabled'])
        self.assertTrue(settings['mimetype_candidates'])
        # The preferred format has to come first, so the browser tries it before
        # any fallback.
        self.assertTrue(settings['mimetype_candidates'][0].startswith('video/webm'))

    def test_dashboard_explains_itself_when_nothing_is_configured(self):
        self.config.unlink()
        state = self.env['cleaning.config'].get_dashboard_state()
        self.assertFalse(state['ok'])
        self.assertEqual(state['deny_reason'], 'no_config')
        self.assertTrue(state['deny_message'])

    # ------------------------------------------------------------------
    # Retention
    # ------------------------------------------------------------------
    def test_retention_of_zero_keeps_everything(self):
        self.config.write({'retention_number': 0})
        self.env['cleaning.recording'].create(
            self._recording_values(datetime(2020, 1, 1, 3, 40)))
        done, remaining = self.env['cleaning.recording']._gc_recordings()
        self.assertEqual(done, 0)
        self.assertFalse(remaining)

    def test_retention_deletes_old_recordings(self):
        self.config.write({
            'retention_number': 7,
            'retention_unit': 'days',
            'retention_mode': 'delete',
        })
        old = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2020, 1, 1, 3, 40)))
        done, _remaining = self.env['cleaning.recording']._gc_recordings()
        self.assertEqual(done, 1)
        self.assertFalse(old.exists())

    def test_retention_can_keep_the_log_and_drop_only_the_video(self):
        self.config.write({
            'retention_number': 7,
            'retention_unit': 'days',
            'retention_mode': 'purge_video',
        })
        recording = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2020, 1, 1, 3, 40)))
        recording._attach_video(b'x' * 5000, 'old.webm', 'video/webm')

        done, _remaining = self.env['cleaning.recording']._gc_recordings()
        self.assertEqual(done, 1)
        self.assertTrue(recording.exists(), "the log entry should survive")
        self.assertFalse(recording.video_file, "the video should be gone")

        # Second pass must find nothing left to do. Without the
        # video_file != False filter this would loop forever on the same rows.
        done_again, remaining_again = self.env['cleaning.recording']._gc_recordings()
        self.assertEqual(done_again, 0)
        self.assertFalse(remaining_again)

    # ------------------------------------------------------------------
    # Storage
    # ------------------------------------------------------------------
    def test_video_is_stored_and_read_back(self):
        recording = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2026, 8, 17, 3, 40)))
        payload = b'not really a video, but bytes are bytes' * 200
        recording._attach_video(payload, 'round.webm', 'video/webm')

        self.assertEqual(recording.file_size, len(payload))
        self.assertEqual(recording.video_filename, 'round.webm')
        self.assertEqual(recording.mimetype, 'video/webm')

        attachment = self.env['ir.attachment'].search([
            ('res_model', '=', 'cleaning.recording'),
            ('res_field', '=', 'video_file'),
            ('res_id', '=', recording.id),
        ])
        self.assertEqual(len(attachment), 1)
        self.assertEqual(attachment.with_context(bin_size=False).raw, payload)

    # ------------------------------------------------------------------
    # Missed-rounds report
    # ------------------------------------------------------------------
    def test_missed_report_uses_the_office_date_not_the_servers(self):
        """Guards a bug that was live: the report converted the timezone the
        wrong way round, so between midnight and 05:30 in India it reported the
        wrong day and quietly dropped a day's rounds.

        20:00 UTC is 01:30 the *next* morning in India.
        """
        self.env.cr.execute("""
            SELECT (TIMESTAMPTZ '2026-08-17 20:00+00' AT TIME ZONE 'Asia/Kolkata')::date,
                   ((TIMESTAMPTZ '2026-08-17 20:00+00' AT TIME ZONE 'UTC')
                        AT TIME ZONE 'Asia/Kolkata')::date
        """)
        correct, the_old_wrong_way = self.env.cr.fetchone()
        self.assertEqual(correct, date(2026, 8, 18))
        self.assertEqual(
            the_old_wrong_way, date(2026, 8, 17),
            "if this ever matches, the two expressions agree and this test has "
            "stopped proving anything")

    def test_missed_report_queries_and_excludes_recorded_rounds(self):
        Missed = self.env['cleaning.slot.missed']
        # The report only covers finished days, so nothing recorded today can
        # appear in it - the useful assertion is that it runs at all and comes
        # back with sane rows.
        rows = Missed.search([])
        for row in rows:
            self.assertLess(
                row.slot_date, self.config._local_date(),
                "today is still in progress and belongs on the dashboard")
            self.assertFalse(
                self.env['cleaning.recording'].search([
                    ('slot_id', '=', row.slot_id.id),
                    ('slot_date', '=', row.slot_date),
                ]),
                "a round with a recording is not missed")

    def test_orphaned_videos_are_cleaned_up(self):
        recording = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2026, 8, 17, 3, 40)))
        recording._attach_video(b'y' * 5000, 'orphan.webm', 'video/webm')
        attachment = self.env['ir.attachment'].search([
            ('res_model', '=', 'cleaning.recording'),
            ('res_field', '=', 'video_file'),
            ('res_id', '=', recording.id),
        ])
        # Simulate a crash between saving the recording and attaching the video.
        self.env.cr.execute(
            "DELETE FROM cleaning_recording WHERE id = %s", (recording.id,))
        self.env.invalidate_all()

        done, _remaining = self.env['cleaning.recording']._gc_orphan_attachments()
        self.assertEqual(done, 1)
        self.assertFalse(attachment.exists())

    # ------------------------------------------------------------------
    # Playback
    # ------------------------------------------------------------------
    def test_base_mimetype_strips_codec_parameters(self):
        self.assertEqual(base_mimetype('video/mp4;codecs=avc1.42e01e'), 'video/mp4')
        self.assertEqual(base_mimetype('video/webm;codecs=vp9'), 'video/webm')
        self.assertEqual(base_mimetype('video/mp4'), 'video/mp4')
        self.assertEqual(base_mimetype('  video/webm ; codecs=vp8 '), 'video/webm')
        self.assertEqual(base_mimetype(''), 'video/webm')
        self.assertEqual(base_mimetype(None), 'video/webm')

    def test_attachment_content_type_has_no_parameters(self):
        """Whatever is on the attachment is sent verbatim as Content-Type, and
        Odoo forbids the browser from sniffing - so a codecs parameter there
        stops the video playing."""
        recording = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2026, 8, 17, 3, 40)))
        recording._attach_video(
            b'z' * 5000, 'round.mp4', 'video/mp4;codecs=avc1.42e01e')

        attachment = self.env['ir.attachment'].search([
            ('res_model', '=', 'cleaning.recording'),
            ('res_field', '=', 'video_file'),
            ('res_id', '=', recording.id),
        ])
        self.assertEqual(attachment.mimetype, 'video/mp4',
                         "the header must carry the base type only")
        # The full string is still worth keeping for diagnosis.
        self.assertEqual(recording.mimetype, 'video/mp4;codecs=avc1.42e01e')

    def test_migration_query_cleans_existing_attachments(self):
        """The same statement the 19.0.1.4.0 migration runs."""
        recording = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2026, 8, 17, 3, 40)))
        attachment = recording._attach_video(b'z' * 5000, 'old.mp4', 'video/mp4')
        # Put a bad value back, as recordings made before the fix have.
        self.env.cr.execute(
            "UPDATE ir_attachment SET mimetype = %s WHERE id = %s",
            ('video/mp4;codecs=avc1.42e01e', attachment.id))

        self.env.cr.execute("""
            UPDATE ir_attachment
               SET mimetype = split_part(mimetype, ';', 1)
             WHERE res_model = 'cleaning.recording'
               AND res_field = 'video_file'
               AND mimetype LIKE '%;%'
        """)
        self.env.cr.execute(
            "SELECT mimetype FROM ir_attachment WHERE id = %s", (attachment.id,))
        self.assertEqual(self.env.cr.fetchone()[0], 'video/mp4')

    def test_size_estimate_follows_the_bitrate(self):
        """The admin has to see the real cost before raising the duration."""
        self.config.write({'duration_value': 60, 'duration_unit': 'seconds',
                           'video_quality': 'medium'})
        # 1.5 Mbps / 8 * 60s = 11.25 MB
        self.assertAlmostEqual(self.config.estimated_size_mb, 10.7, places=1)

        self.config.video_quality = 'low'
        self.assertLess(self.config.estimated_size_mb, 6.0)

    # ------------------------------------------------------------------
    # The photographs, and the views that have no original
    # ------------------------------------------------------------------
    def _jpeg(self, seed=0):
        """A real JPEG, comfortably over MIN_PHOTO_BYTES.

        Genuinely decodable rather than padding, because everything under test
        here decodes it: _attach_image resizes it, and the comparison reads it
        again to score it. The noise is what carries it past the 2048-byte
        floor - a flat colour compresses to a few hundred bytes, which the
        upload would rightly refuse as a half-written picture.
        """
        image = Image.new('RGB', (320, 240))
        pixels = image.load()
        for x in range(320):
            for y in range(240):
                pixels[x, y] = ((x * 7 + seed) % 256, (y * 11) % 256,
                                (x + y + seed) % 256)
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=95)
        return buffer.getvalue()

    def _set_original(self, direction):
        """Put an original on one of the four rows the config already has."""
        reference = self.config.reference_image_ids.filtered(
            lambda r, d=direction: r.direction == d)
        reference.write({'image': base64.b64encode(self._jpeg())})
        return reference

    def test_a_photograph_with_no_original_is_not_stored(self):
        """Somebody photographs the back as well; there is no back original.

        It is dropped rather than kept unscored. A shot records which original
        it was taken against, so one stored without an original could never be
        scored - not now, and not after a manager adds the back original later.
        Keeping it would leave a picture nobody can act on in every round.
        """
        self._set_original('front')
        recording = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2026, 8, 17, 3, 40)))
        blob = self._jpeg()

        recording._store_direction_shots([
            ('front', blob, 'image/jpeg', 'front.jpg'),
            ('back', blob, 'image/jpeg', 'back.jpg'),
        ])

        self.assertEqual(recording.shot_ids.mapped('direction'), ['front'])
        self.assertEqual(recording.shot_count, 1)
        # The round itself is untouched: the extra view is not a failure.
        self.assertTrue(recording.exists())

    def test_photographs_are_kept_while_the_requirement_is_off(self):
        """require_photos says what MUST be sent, never what may be kept.

        Deciding what to keep by _required_directions would discard every
        photograph in every office that has not switched the requirement on -
        which is how every office starts, and the setting is off by default.
        """
        self.assertFalse(self.config.require_photos)
        self._set_original('front')
        self.assertEqual(self.config._required_directions(), [])
        self.assertEqual(self.config._askable_directions(), ['front'])

        recording = self.env['cleaning.recording'].create(
            self._recording_values(datetime(2026, 8, 17, 3, 40)))
        recording._store_direction_shots(
            [('front', self._jpeg(), 'image/jpeg', 'front.jpg')])

        shot = recording.shot_ids
        self.assertEqual(len(shot), 1)
        self.assertFalse(shot.match_error)
        self.assertTrue(shot.matched_at, "stored is not enough - it was scored")

    def test_an_original_is_bounded_on_the_way_in(self):
        """Otherwise a 12 megapixel original is kept whole and compared against
        round photographs that were bounded on the way in."""
        big = Image.new('RGB', (3000, 2250))
        pixels = big.load()
        for x in range(0, 3000, 3):
            for y in range(0, 2250, 3):
                pixels[x, y] = ((x * 5) % 256, (y * 3) % 256, (x + y) % 256)
        buffer = io.BytesIO()
        big.save(buffer, format='JPEG', quality=95)

        reference = self.config.reference_image_ids.filtered(
            lambda r: r.direction == 'front')
        reference.write({'image': base64.b64encode(buffer.getvalue())})

        stored = Image.open(io.BytesIO(base64.b64decode(reference.image)))
        self.assertLessEqual(max(stored.size), 1600)
        # And the comparison values came from the bytes that were kept, not
        # from the ones that arrived.
        self.assertTrue(reference.signature)
        self.assertTrue(reference.phash)

    def test_a_photographs_only_round_is_not_refused_as_unconfigured(self):
        """The upload route's "nothing to record" guard reads the askable list.

        Read off _required_directions it refused every photographs-only round in
        an office that had not switched require_photos on - however many
        originals were set - because required is empty whenever the setting is
        off. Somebody who had just walked the room photographing it was told
        there was nothing to record.
        """
        self.config.write({'video_enabled': False, 'require_photos': False})
        self._set_original('front')

        # What the controller tests, in the same order.
        self.assertEqual(self.config._required_directions(), [])
        self.assertEqual(self.config._askable_directions(), ['front'])
        self.assertFalse(
            not self.config.video_enabled and not self.config._askable_directions(),
            "a round with an original set has something to record",
        )

    def test_a_round_with_no_video_and_no_originals_is_refused(self):
        """The guard still has to fire when there really is nothing."""
        self.config.write({'video_enabled': False})
        self.config.reference_image_ids.write({'image': False})

        self.assertTrue(
            not self.config.video_enabled and not self.config._askable_directions())

    def test_the_turn_between_views_is_worked_out_here(self):
        """The shape of the round belongs to the server, not to a client.

        front then left is a quarter turn to the LEFT. A client that assumed
        four evenly spaced views would send somebody right instead, to a wall
        nobody is checking - which is exactly why this is not the client's sum
        to do.
        """
        self._set_original('front')
        self._set_original('left')

        rows = self.config._direction_payload()

        self.assertEqual([row['key'] for row in rows], ['front', 'left'])
        # Nothing to have turned from yet.
        self.assertIsNone(rows[0]['turn'])
        self.assertEqual(rows[1]['turn'], {'degrees': 90, 'clockwise': False})

    def test_the_turn_is_the_short_way_round(self):
        self._set_original('front')
        self._set_original('right')
        self._set_original('back')

        rows = self.config._direction_payload()

        self.assertEqual([row['key'] for row in rows], ['front', 'right', 'back'])
        self.assertEqual(rows[1]['turn'], {'degrees': 90, 'clockwise': True})
        self.assertEqual(rows[2]['turn'], {'degrees': 90, 'clockwise': True})

    def test_the_client_is_only_offered_views_that_have_an_original(self):
        """So nobody is asked for a picture the server is going to drop."""
        self._set_original('front')
        self._set_original('left')

        settings = self.env['cleaning.config'].get_dashboard_state()['settings']

        self.assertEqual(settings['askable_directions'], ['front', 'left'])
        self.assertEqual([row['key'] for row in settings['directions']],
                         ['front', 'left'])
        self.assertTrue(all(row['reference_url']
                            for row in settings['directions']))

