import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../src/api/errors';
import { fetchNotifications, markNotificationsSeen } from '../src/api/cleaning';
import { useAuth } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../src/components/GradientBackground';
import { formatGroupDate } from '../src/cleaning/dates';
import { translateError, useT } from '../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../src/theme';

/** Rows arrive newest first, so one pass groups them by day. */
function groupByDate(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.date !== row.slot_date) {
      current = { date: row.slot_date, items: [] };
      groups.push(current);
    }
    current.items.push(row);
  }
  return groups;
}

/**
 * Rounds that came in below the level a manager set.
 *
 * The durable half of the notification. A push tells somebody now and is gone
 * the moment it is swiped away -- or never arrives at all, on a phone that was
 * off, or one that never registered. This is what is still here afterwards,
 * and it is why the list exists rather than push alone.
 *
 * Derived, not stored: the server searches for rounds under the threshold
 * rather than replaying rows it wrote at the time. Move the threshold and this
 * screen re-answers for the whole history, which is the same trade the verdict
 * bands make by staying unstored on the server.
 */
export default function NotificationsRoute() {
  return (
    <RequireAuth>
      <NotificationsScreen />
    </RequireAuth>
  );
}

function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await fetchNotifications(connection.baseUrl);
      setFeed(result || null);
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setLoading(false);
    }
  }, [connection, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Marked read once, on arrival, rather than per row. Opening the screen IS
  // having seen them; asking somebody to tick off each round would be work for
  // its own sake. Deliberately not awaited into the render path -- a failed
  // mark must not stop the list being shown.
  useEffect(() => {
    void markNotificationsSeen(connection.baseUrl).catch(() => {});
  }, [connection]);

  const groups = useMemo(() => groupByDate(feed?.rows || []), [feed]);

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]}>{t.lowRounds}</Text>
        </View>
        {feed?.threshold ? (
          <Text style={[styles.subtitle, rtlText]}>
            {t.lowRoundsBelow.replace('%s', String(feed.threshold))}
          </Text>
        ) : null}
      </GradientBackground>

      {error ? <ErrorBanner message={error} /> : null}

      <FlatList
        data={groups}
        keyExtractor={(group) => group.date}
        contentContainerStyle={[styles.body, { paddingBottom: spacing.xxxl + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        refreshing={loading}
        onRefresh={load}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>✅</Text>
              <Text style={styles.emptyTitle}>{t.noLowRounds}</Text>
              <Text style={[styles.emptyText, rtlText]}>{t.noLowRoundsBody}</Text>
            </View>
          )
        }
        renderItem={({ item: group }) => (
          <View style={styles.group}>
            <Text style={[styles.groupTitle, rtlText]}>{formatGroupDate(group.date, t)}</Text>
            {group.items.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => router.push(`/comparison/${item.id}`)}
                accessibilityRole="button"
                style={[styles.row, rtlRow]}
              >
                {/* Filled while unread, hollow once seen. The whole difference
                    a badge count is counting, said on the row itself. */}
                <View style={[styles.dot, item.is_unread ? null : styles.dotSeen]} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, rtlText]} numberOfLines={1}>
                    {item.slot_name || t.round}
                  </Text>
                  <Text style={[styles.rowMeta, rtlText]} numberOfLines={1}>
                    {[item.match_worst_label, item.user_name].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Text style={styles.score}>{`${item.match_score}%`}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </Pressable>
            ))}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    // GradientBackground defaults to flex:1, which here would make this header
    // eat the whole screen. Same note as on the Missed and History headers.
    flex: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: 22, fontWeight: '700', color: colors.white, letterSpacing: -0.4 },
  subtitle: {
    marginTop: spacing.xs,
    fontSize: 13,
    color: colors.onGradientMuted,
  },

  body: { padding: spacing.xl, gap: spacing.md },
  spinner: { marginTop: spacing.xxxl },

  group: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  groupTitle: { ...typography.overline },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.warning },
  dotSeen: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  rowText: { flex: 1 },
  rowTitle: { ...typography.body },
  rowMeta: { ...typography.caption },
  score: { fontSize: 15, fontWeight: '800', color: colors.warning },

  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.heading },
  emptyText: { ...typography.caption, textAlign: 'center', paddingHorizontal: spacing.xl },
});
