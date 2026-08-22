import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import { getDashboardState } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { Avatar } from '../../src/components/Avatar';
import { useDialog, useTimeoutDialog } from '../../src/components/AppDialog';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { NotificationBell } from '../../src/components/NotificationBell';
import { OpenRoundCard } from '../../src/components/OpenRoundCard';
import { ProgressRing } from '../../src/components/ProgressRing';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { RoundCard } from '../../src/components/RoundCard';
import { useSlotClock } from '../../src/cleaning/useSlotClock';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';
import { log } from '../../src/utils/log';

export default function RoundsRoute() {
  return (
    <RequireAuth>
      <RoundsScreen />
    </RequireAuth>
  );
}

function RoundsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, connection, signOut } = useAuth();
  const { confirm } = useDialog();
  const { t, rtlRow, rtlText } = useT();

  useEffect(() => {
    log('screen', 'rounds mounted');
  }, []);

  const confirmSignOut = useCallback(() => {
    confirm({
      title: t.logOut,
      message: t.logOutMessage,
      icon: 'log-out-outline',
      tone: 'danger',
      actions: [
        {
          label: t.logOut,
          style: 'destructive',
          onPress: () => {
            log('rounds', 'log out');
            void signOut().then(() => router.replace('/login'));
          },
        },
        { label: t.cancel, style: 'cancel' },
      ],
    });
  }, [confirm, router, signOut, t]);

  // Manager-only, mirroring the web's Configuration menu.
  const openConfiguration = useCallback(() => {
    confirm({
      title: t.configuration,
      icon: 'settings-outline',
      actions: [
        { label: t.settings, icon: 'options-outline', onPress: () => router.push('/settings') },
        {
          label: t.configRounds,
          icon: 'time-outline',
          onPress: () => router.push('/settings/rounds'),
        },
        {
          label: t.sectionAiReview,
          icon: 'sparkles-outline',
          onPress: () => router.push('/settings/ai'),
        },
        { label: t.cancel, style: 'cancel' },
      ],
    });
  }, [confirm, router, t]);

  const fetchState = useCallback(() => {
    if (!connection) throw new AppError('session_expired');
    log('rounds', 'requesting dashboard state', connection.baseUrl);
    return getDashboardState(connection.baseUrl);
  }, [connection]);

  const { loading, error, data, countdowns, pending, refresh, pause, resume } =
    useSlotClock(fetchState);

  // The dashboard is the one screen that asks the server on its own, without
  // anybody pressing anything, so a server that has stopped answering shows up
  // here first. The banner stays underneath - this is the interruption, not
  // the record.
  useTimeoutDialog(error, refresh);

  useEffect(() => {
    if (!data) return;
    log('rounds', 'dashboard state', {
      ok: data.ok,
      is_allowed: data.is_allowed,
      today: data.today,
      timezone: data.timezone,
      done: data.today_done,
      total: data.today_total,
      missed: data.today_missed,
      deny_message: data.deny_message,
      slots: (data.slots || []).map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        window: s.window_label,
        recording_id: s.recording_id,
        can_view: s.can_view,
      })),
    });
  }, [data]);

  useEffect(() => {
    if (error) log('rounds', 'dashboard failed', AppError.from(error).message);
  }, [error]);

  // Coming back from the camera, ask the server again straight away so the
  // round that was just recorded flips over without waiting for the next poll.
  useFocusEffect(
    useCallback(() => {
      log('rounds', 'focused - resuming poll');
      resume();
      return () => {
        log('rounds', 'blurred - pausing poll');
        pause();
      };
    }, [pause, resume]),
  );

  // The card at the top always says what to do next: record the open round,
  // wait for the coming one, or nothing more today.
  const active = data?.active_slot && !data.active_slot.already_recorded ? data.active_slot : null;
  const upNext = !active && data?.next_slot ? data.next_slot : null;
  const heroMode = active ? 'open' : upNext ? 'next' : data?.today_total ? 'done' : null;
  const heroRound = active ?? upNext;
  // Filtered out below so the round is not shown twice.
  const slots = (data?.slots ?? []).filter((s) => !active || s.id !== active.id);

  // A round with the video switched off is photographs and nothing else, so the
  // button should not promise a recording. Tested against `false` rather than
  // falsiness, so a server too old to send the flag keeps saying "Record now"
  // instead of quietly renaming the button on every dashboard.
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return t.goodMorning;
    if (hour < 18) return t.goodAfternoon;
    return t.goodEvening;
  }, [t]);

  const openRecorder = useCallback(
    (round) => {
      log('rounds', 'open recorder', { id: round.id, name: round.name, state: round.state });
      return router.push({ pathname: '/recorder', params: { slotId: String(round.id) } });
    },
    [router],
  );
  const watch = useCallback(
    (round) => {
      log('rounds', 'open player', { id: round.id, recording_id: round.recording_id });
      return router.push(`/recording/${round.recording_id}`);
    },
    [router],
  );

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.primary} />
        }
      >
        <GradientBackground style={[styles.header, { paddingTop: insets.top + spacing.xl }]}>
          <GradientOrbs />
          {/* Greeting, mark, controls. The three of them fit only because each
              is sized to leave the others room: the mark is pinned to the
              centre of the row rather than laid out around what is beside it,
              so anything too wide either side is simply covered up. The sum
              that keeps them apart is written out over styles.headerRow. */}
          <View style={[styles.headerRow, rtlRow]}>
            <View style={styles.headerText}>
              <Text style={[styles.greeting, rtlText]}>{greeting},</Text>
              <Text style={[styles.name, rtlText]} numberOfLines={1}>
                {user?.name?.split(/\s+/)[0] ?? 'there'}
              </Text>
            </View>

            {/* Centred on the row rather than sitting in the flow, so it stays
                dead centre whether or not the settings button is there. Laid
                out over the row and non-interactive, so it cannot swallow a tap
                meant for anything underneath it. */}
            <View pointerEvents="none" style={styles.markWrap}>
              {/* The mark alone, not the full wordmark: "ai.Biz" and the
                  tagline are unreadable at this size. Nothing behind it - the
                  file is transparent, so what carries it is its own size, the
                  white highlights down the numerals and the orange arrow. The
                  blue itself is #2E7DBF to #7EC2EE against a #4F46E5 gradient,
                  the same family at much the same brightness, so the flat
                  areas will always be quiet. */}
              <Image
                source={require('../../assets/logo-369-mark.png')}
                style={styles.markImage}
                resizeMode="contain"
                accessibilityRole="image"
                accessibilityLabel="369"
              />
            </View>

            {/* Takes whatever width is left over. justifyContent cannot do this
                job here: maxWidth stops the greeting's flex:1 from absorbing
                the slack, so flex-end packed the greeting against the controls
                and left the start of the row empty - with the greeting sitting
                straight on top of the centred mark. */}
            <View style={styles.headerSpacer} />

            {data?.is_manager ? (
              <Pressable
                onPress={openConfiguration}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t.configuration}
                style={styles.logOut}
              >
                <Ionicons name="settings-outline" size={20} color={colors.white} />
              </Pressable>
            ) : null}
            {/* Managers only, and not drawn at all otherwise. How many rounds
                scored badly is not something to put in front of the people
                being measured, even as a number they cannot open. The server
                agrees rather than trusting this: low_match_unread comes back
                as a flat 0 for anybody else. */}
            {data?.is_manager ? (
              <NotificationBell
                count={data.low_match_unread || 0}
                onPress={() => router.push('/notifications')}
                accessibilityLabel={t.lowRounds}
              />
            ) : null}
            {/* Sign out is reachable from the landing screen, not only buried
                in Profile - it is also the way back to a different server. */}
            <Pressable
              onPress={confirmSignOut}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t.logOut}
              style={styles.logOut}
            >
              <Ionicons name="log-out-outline" size={20} color={colors.white} />
            </Pressable>
            {/* The face is the most obvious way into Profile, so make it the
                shortcut rather than leaving the tab bar as the only route. */}
            <Pressable
              onPress={() => router.navigate('/profile')}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t.tabProfile}
            >
              <Avatar name={user?.name} base64={user?.avatarBase64} size={40} ring />
            </Pressable>
          </View>

          {data?.today ? (
            <Text style={[styles.today, rtlText]}>
              {data.today}
              {data.timezone ? `  ·  ${data.timezone}` : ''}
            </Text>
          ) : null}

          {data ? (
            <View style={[styles.summary, rtlRow]}>
              <ProgressRing
                done={data.today_done}
                total={data.today_total}
                missed={data.today_missed}
                caption={t.statRecorded.toUpperCase()}
              />
              {data.today_missed > 0 ? (
                <Pressable
                  onPress={() => data.is_manager && router.push('/missed')}
                  disabled={!data.is_manager}
                  accessibilityRole={data.is_manager ? 'button' : 'text'}
                  style={[styles.missedChip, rtlRow]}
                >
                  <View style={styles.missedDot} />
                  <Text style={styles.missedText}>
                    {data.today_missed} {t.statMissed}
                  </Text>
                  {data.is_manager ? (
                    <Ionicons name="chevron-forward" size={13} color={colors.white} />
                  ) : null}
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </GradientBackground>

        <View style={styles.body}>
          {loading && !data ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : null}

          {error ? (
            <View style={styles.gap}>
              <ErrorBanner message={translateError(t, AppError.from(error))} />
              <PrimaryButton label={t.tryAgain} variant="ghost" onPress={refresh} />
            </View>
          ) : null}

          {/* Configured, but this person is not on the allowed list. */}
          {data && !data.is_allowed && data.deny_message ? (
            <View style={styles.gap}>
              <ErrorBanner message={data.deny_message} tone="warning" />
            </View>
          ) : null}

          {data && data.ok === false ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🧹</Text>
              <Text style={styles.emptyTitle}>{t.nothingSetUp}</Text>
              <Text style={styles.emptyText}>{data.deny_message}</Text>
            </View>
          ) : null}

          {/* Only when the day is genuinely empty -- the hero counts as content,
              or a single open round would show "no rounds" beneath its own card. */}
          {data?.ok && !slots.length && !heroMode ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🧹</Text>
              <Text style={styles.emptyTitle}>{t.noRoundsToday}</Text>
              <Text style={styles.emptyText}>{t.noRoundsTodayBody}</Text>
            </View>
          ) : null}

          {heroMode ? (
            <OpenRoundCard
              mode={heroMode}
              round={heroRound}
              countdown={heroRound ? countdowns[heroRound.id] : undefined}
              onRecord={openRecorder}
              denyMessage={data?.deny_message || undefined}
              done={data?.today_done}
              total={data?.today_total}
            />
          ) : null}

          {slots.map((round) => (
            <RoundCard
              key={round.id}
              round={round}
              countdown={countdowns[round.id]}
              pending={!!pending[round.id]}
              canRecord={data?.is_allowed && round.state === 'open' && !round.recording_id}
              onRecord={openRecorder}
              onWatch={watch}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: spacing.xxxl },
  header: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  // The mark is not in the flow of this row - it is pinned across the middle
  // of it - so the greeting and the three controls have to be small enough to
  // stay out of its way. That is one sum, taken at 360pt, the narrowest phone
  // worth having, with a manager's three controls:
  //
  //   row      360 - 2 x spacing.xl              = 320
  //   controls 32 + 8 + 32 + 8 + 40              = 120  ->  200...320
  //            (headerSpacer takes the rest, so the extra gap it brings
  //             comes out of the slack rather than out of this sum)
  //   greeting 34% of 320                        = 108.8 ->   0...108.8
  //   mark     36 x 459/232                      =  71.2, centred on 160
  //                                              -> 124.4...195.6
  //
  // which leaves 15.6pt of daylight on one side and 4.4pt on the other. Every
  // wider screen has more, and a non-manager has 40pt more again. Grow any one
  // of those figures without redoing the sum and the mark goes straight back
  // under the gear, which is how it got there twice already.
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerSpacer: { flex: 1 },
  markWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Height fixed, width from the source ratio, so it can never distort - and
  // the width is the half of it that matters, because with no backing the
  // artwork itself is what has to stay clear of the gear. 36 x 459/232 is
  // 71.2pt wide; see the sum over styles.headerRow for where that has to fit.
  // 40 is the most that will go in without the controls shrinking too.
  markImage: { height: 36, aspectRatio: 459 / 232 },
  // Capped so a long name truncates before it reaches the centred mark. No
  // flex:1 - headerSpacer is what claims the slack, and two items growing into
  // it would share it and drag the greeting back towards the middle.
  headerText: { maxWidth: '34%' },
  logOut: {
    // 32 rather than 38, and the hitSlop of 10 either side leaves the tap
    // target at 52 - larger than the button ever was to touch.
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  greeting: { fontSize: 13, fontWeight: '500', color: colors.onGradientMuted },
  name: { fontSize: 24, fontWeight: '700', color: colors.white, letterSpacing: -0.4 },
  today: { fontSize: 12, fontWeight: '500', color: colors.onGradientMuted, marginTop: spacing.md },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginTop: spacing.xl,
  },
  missedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
  },
  missedDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.danger },
  missedText: { fontSize: 12, fontWeight: '700', color: colors.white },

  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, gap: spacing.lg },
  center: { paddingVertical: spacing.xxxl, alignItems: 'center' },
  gap: { gap: spacing.md },
  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.title },
  emptyText: { ...typography.caption, textAlign: 'center', lineHeight: 18 },
});
