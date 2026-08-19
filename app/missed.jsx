import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../src/api/errors';
import { fetchMissedRounds } from '../src/api/cleaning';
import { formatFloatTime } from '../src/api/config';
import { useAuth } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../src/components/GradientBackground';
import { formatGroupDate } from '../src/cleaning/dates';
import { translateError, useT } from '../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../src/theme';

const relationName = (value) => (Array.isArray(value) ? value[1] : '');

const PERIOD_KEYS = {
  morning: 'periodMorning',
  afternoon: 'periodAfternoon',
  evening: 'periodEvening',
  night: 'periodNight',
};

/** Rows arrive ordered `slot_date desc, hour_from`, so one pass groups them. */
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
 * Rounds that were scheduled and never recorded.
 *
 * Reached from the Missed figure on the dashboard, because "which ones?" is
 * asked where the number that prompts it is shown.
 */
export default function MissedRoute() {
  return (
    <RequireAuth>
      <MissedScreen />
    </RequireAuth>
  );
}

function MissedScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await fetchMissedRounds(connection.baseUrl);
      setRows(result || []);
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setLoading(false);
    }
  }, [connection, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupByDate(rows), [rows]);

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]}>{t.missedRounds}</Text>
        </View>
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
              <Text style={styles.emptyTitle}>{t.nothingMissed}</Text>
              <Text style={[styles.emptyText, rtlText]}>{t.nothingMissedBody}</Text>
            </View>
          )
        }
        renderItem={({ item: group }) => (
          <View style={styles.group}>
            <Text style={[styles.groupTitle, rtlText]}>{formatGroupDate(group.date, t)}</Text>
            {group.items.map((item) => (
              <View key={item.id} style={[styles.row, rtlRow]}>
                <View style={styles.dot} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, rtlText]} numberOfLines={1}>
                    {relationName(item.slot_id) || t.round}
                  </Text>
                  <Text style={[styles.rowMeta, rtlText]}>
                    {`${formatFloatTime(item.hour_from)} - ${formatFloatTime(item.hour_to)}${
                      PERIOD_KEYS[item.day_period] ? ` · ${t[PERIOD_KEYS[item.day_period]]}` : ''
                    }`}
                  </Text>
                </View>
              </View>
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
    // eat the whole screen. See the same note on the History header.
    flex: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: 22, fontWeight: '700', color: colors.white, letterSpacing: -0.4 },

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
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  rowText: { flex: 1 },
  rowTitle: { ...typography.body },
  rowMeta: { ...typography.caption },

  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.heading },
  emptyText: { ...typography.caption, textAlign: 'center', paddingHorizontal: spacing.xl },
});
