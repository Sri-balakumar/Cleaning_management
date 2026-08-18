import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
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
import { useDialog } from '../../src/components/AppDialog';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
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

  // Manager-only. The gear mirrors the web's Configuration menu, which holds
  // exactly these two entries.
  const openConfiguration = useCallback(() => {
    confirm({
      title: t.configuration,
      icon: 'settings-outline',
      actions: [
        { label: t.settings, icon: 'options-outline', onPress: () => router.push('/settings') },
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
          <View style={[styles.headerRow, rtlRow]}>
            <View style={styles.headerText}>
              <Text style={[styles.greeting, rtlText]}>{greeting},</Text>
              <Text style={[styles.name, rtlText]} numberOfLines={1}>
                {user?.name?.split(/\s+/)[0] ?? 'there'}
              </Text>
            </View>
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
              <Avatar name={user?.name} base64={user?.avatarBase64} size={48} ring />
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
                <View style={[styles.missedChip, rtlRow]}>
                  <View style={styles.missedDot} />
                  <Text style={styles.missedText}>
                    {data.today_missed} {t.statMissed}
                  </Text>
                </View>
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
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  headerText: { flex: 1 },
  logOut: {
    width: 38,
    height: 38,
    borderRadius: 19,
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
