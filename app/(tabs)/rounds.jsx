import React, { useCallback, useMemo } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import { getDashboardState } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { Avatar } from '../../src/components/Avatar';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { RoundCard } from '../../src/components/RoundCard';
import { useSlotClock } from '../../src/cleaning/useSlotClock';
import { colors, radius, spacing, typography } from '../../src/theme';

export default function RoundsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, connection } = useAuth();

  const fetchState = useCallback(() => {
    if (!connection) throw new AppError('session_expired');
    return getDashboardState(connection.baseUrl);
  }, [connection]);

  const { loading, error, data, countdowns, pending, refresh, pause, resume } =
    useSlotClock(fetchState);

  // Coming back from the camera, ask the server again straight away so the
  // round that was just recorded flips over without waiting for the next poll.
  useFocusEffect(
    useCallback(() => {
      resume();
      return pause;
    }, [pause, resume]),
  );

  const slots = data?.slots ?? [];
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const openRecorder = useCallback(
    (round) => router.push({ pathname: '/recorder', params: { slotId: String(round.id) } }),
    [router],
  );
  const watch = useCallback(
    (round) => router.push(`/player/${round.recording_id}`),
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
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <Text style={styles.greeting}>{greeting},</Text>
              <Text style={styles.name} numberOfLines={1}>
                {user?.name?.split(/\s+/)[0] ?? 'there'}
              </Text>
            </View>
            <Avatar name={user?.name} base64={user?.avatarBase64} size={48} ring />
          </View>

          {data?.today ? (
            <Text style={styles.today}>
              {data.today}
              {data.timezone ? `  ·  ${data.timezone}` : ''}
            </Text>
          ) : null}

          {data ? (
            <View style={styles.stats}>
              <Stat value={data.today_done} label="Recorded" />
              <Stat value={data.today_total} label="Rounds" />
              <Stat value={data.today_missed} label="Missed" bad={data.today_missed > 0} />
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
              <ErrorBanner message={AppError.from(error).message} />
              <PrimaryButton label="Try again" variant="ghost" onPress={refresh} />
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
              <Text style={styles.emptyTitle}>Nothing set up yet</Text>
              <Text style={styles.emptyText}>{data.deny_message}</Text>
            </View>
          ) : null}

          {data?.ok && !slots.length ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🧹</Text>
              <Text style={styles.emptyTitle}>No rounds today</Text>
              <Text style={styles.emptyText}>
                There are no cleaning rounds scheduled for today.
              </Text>
            </View>
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

function Stat({ value, label, bad }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, bad && styles.statBad]}>{value ?? '—'}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
  greeting: { fontSize: 13, fontWeight: '500', color: colors.onGradientMuted },
  name: { fontSize: 24, fontWeight: '700', color: colors.white, letterSpacing: -0.4 },
  today: { fontSize: 12, fontWeight: '500', color: colors.onGradientMuted, marginTop: spacing.md },
  stats: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  stat: {
    flex: 1,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '700', color: colors.white },
  statBad: { color: '#FCA5A5' },
  statLabel: { fontSize: 11, fontWeight: '600', color: colors.onGradientMuted, marginTop: 2 },

  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, gap: spacing.lg },
  center: { paddingVertical: spacing.xxxl, alignItems: 'center' },
  gap: { gap: spacing.md },
  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.title },
  emptyText: { ...typography.caption, textAlign: 'center', lineHeight: 18 },
});
