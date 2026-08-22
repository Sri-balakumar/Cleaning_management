import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../src/api/errors';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../src/api/cleaning';
import { useAuth } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../src/components/GradientBackground';
import { SectionTabs } from '../src/components/SectionTabs';
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
 * off, or one that never registered. This is what is still here afterwards.
 *
 * Derived, not stored: the server searches for rounds under the threshold
 * rather than replaying rows it wrote at the time. Move the threshold and this
 * screen re-answers for the whole history. Only which rounds this user has
 * READ is stored, because that is the one thing no search can work out.
 *
 * Nothing is marked read just by arriving here. Opening the bell is not the
 * same as having dealt with what is in it, and a list that empties itself on
 * sight makes the unread filter useless the moment it is used.
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
  const [filter, setFilter] = useState('unread');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(
    async (only = filter) => {
      setError(null);
      try {
        setFeed(await fetchNotifications(connection.baseUrl, { only }));
      } catch (e) {
        setError(translateError(t, AppError.from(e)));
      } finally {
        setLoading(false);
      }
    },
    [connection, filter, t],
  );

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Coming back from a round should show it as read, since opening it is
  // exactly what marks it.
  useFocusEffect(
    useCallback(() => {
      void load(filter);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter]),
  );

  const onRow = useCallback(
    async (item) => {
      // Marked read on the way out rather than on return, so the round is
      // already read by the time its detail screen is drawn. A failure here
      // must not block opening it -- being unable to tick something off is a
      // far smaller problem than being unable to look at it.
      if (item.is_unread) {
        markNotificationRead(connection.baseUrl, [item.id]).catch(() => {});
      }
      router.push(`/comparison/${item.id}`);
    },
    [connection, router],
  );

  const onToggleRead = useCallback(
    async (item) => {
      try {
        await markNotificationRead(connection.baseUrl, [item.id], item.is_unread);
        await load(filter);
      } catch (e) {
        setError(translateError(t, AppError.from(e)));
      }
    },
    [connection, filter, load, t],
  );

  const onMarkAll = useCallback(async () => {
    try {
      await markAllNotificationsRead(connection.baseUrl);
      await load(filter);
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    }
  }, [connection, filter, load, t]);

  const tabs = useMemo(
    () => [
      { key: 'unread', label: `${t.filterUnread} (${feed?.unread_count ?? 0})` },
      { key: 'read', label: `${t.filterRead} (${feed?.read_count ?? 0})` },
      { key: 'all', label: `${t.filterAll} (${feed?.total_count ?? 0})` },
    ],
    [feed, t],
  );

  const groups = useMemo(() => groupByDate(feed?.rows || []), [feed]);
  const emptyText =
    filter === 'read' ? t.noReadRounds : filter === 'unread' ? t.noUnreadRounds : t.noLowRoundsBody;

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]}>{t.lowRounds}</Text>
          <View style={styles.spacer} />
          {/* Only offered when it would do something. A "mark all read" that
              is already true reads as a broken button. */}
          {feed?.unread_count ? (
            <Pressable onPress={onMarkAll} hitSlop={10} accessibilityRole="button">
              <Text style={styles.markAll}>{t.markAllRead}</Text>
            </Pressable>
          ) : null}
        </View>
        {feed?.threshold ? (
          <Text style={[styles.subtitle, rtlText]}>
            {t.lowRoundsBelow.replace('%s', String(feed.threshold))}
          </Text>
        ) : null}
      </GradientBackground>

      <View style={styles.tabs}>
        <SectionTabs tabs={tabs} value={filter} onChange={setFilter} />
      </View>

      {error ? <ErrorBanner message={error} /> : null}

      <FlatList
        data={groups}
        keyExtractor={(group) => group.date}
        contentContainerStyle={[styles.body, { paddingBottom: spacing.xxxl + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        refreshing={loading}
        onRefresh={() => load(filter)}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>✅</Text>
              <Text style={styles.emptyTitle}>{t.noLowRounds}</Text>
              <Text style={[styles.emptyText, rtlText]}>{emptyText}</Text>
            </View>
          )
        }
        renderItem={({ item: group }) => (
          <View style={styles.group}>
            <Text style={[styles.groupTitle, rtlText]}>{formatGroupDate(group.date, t)}</Text>
            {group.items.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => onRow(item)}
                accessibilityRole="button"
                style={[styles.row, rtlRow]}
              >
                <View style={[styles.dot, item.is_unread ? null : styles.dotRead]} />
                <View style={styles.rowText}>
                  <Text
                    style={[styles.rowTitle, item.is_unread && styles.rowTitleUnread, rtlText]}
                    numberOfLines={1}
                  >
                    {item.slot_name || t.round}
                  </Text>
                  <Text style={[styles.rowMeta, rtlText]} numberOfLines={1}>
                    {[item.match_worst_label, item.user_name].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Text style={styles.score}>{`${item.match_score}%`}</Text>
                {/* Both directions. A bell that can only be emptied is one
                    people stop trusting: opening a round by accident should
                    not lose the one thing saying it still needs a look. */}
                <Pressable
                  onPress={() => onToggleRead(item)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={item.is_unread ? t.markRead : t.markUnread}
                >
                  <Ionicons
                    name={item.is_unread ? 'mail-unread-outline' : 'mail-open-outline'}
                    size={18}
                    color={colors.textMuted}
                  />
                </Pressable>
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
  spacer: { flex: 1 },
  markAll: { fontSize: 13, fontWeight: '700', color: colors.white },
  subtitle: { marginTop: spacing.xs, fontSize: 13, color: colors.onGradientMuted },

  tabs: { paddingHorizontal: spacing.xl, paddingTop: spacing.md },
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
  dotRead: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  rowText: { flex: 1 },
  rowTitle: { ...typography.body },
  rowTitleUnread: { fontWeight: '800' },
  rowMeta: { ...typography.caption },
  score: { fontSize: 15, fontWeight: '800', color: colors.warning },

  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.heading },
  emptyText: { ...typography.caption, textAlign: 'center', paddingHorizontal: spacing.xl },
});
