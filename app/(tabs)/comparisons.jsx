import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import { fetchRecordings } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { formatGroupDate, formatTime } from '../../src/cleaning/dates';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';
import { log } from '../../src/utils/log';

const relationName = (value) => (Array.isArray(value) ? value[1] : '');

/** The band colours the Photographs card already uses, so the two agree. */
const BAND_COLOR = {
  alert: colors.danger,
  warn: colors.warning,
  unknown: colors.textMuted,
  ok: colors.success,
};
const BAND_KEY = {
  alert: 'matchAlert',
  warn: 'matchWarn',
  unknown: 'matchUnknown',
  ok: 'matchOk',
};

/**
 * Rows arrive ordered `slot_date desc, id desc`, so one pass produces the days
 * already in the right order -- no sorting, and no second request.
 */
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

export default function ComparisonsRoute() {
  return (
    <RequireAuth>
      <ComparisonsScreen />
    </RequireAuth>
  );
}

function ComparisonsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState({});

  const load = useCallback(async () => {
    setError(null);
    try {
      // The same call History makes, asked a different question. A round with a
      // clip but no photographs has no comparison to show.
      const result = await fetchRecordings(connection.baseUrl, {
        domain: [['shot_count', '>', 0]],
      });
      setRows(result || []);
      log('comparisons', `loaded ${(result || []).length} rounds`);
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setLoading(false);
    }
  }, [connection, t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const groups = useMemo(() => groupByDate(rows), [rows]);

  // The newest day is open unless it has been closed by hand: a fully collapsed
  // screen reads as empty, and today is what this tab is opened for.
  const isOpen = useCallback(
    (date, index) => (date in collapsed ? !collapsed[date] : index === 0),
    [collapsed],
  );
  const toggle = useCallback(
    (date, index) =>
      setCollapsed((prev) => ({ ...prev, [date]: date in prev ? !prev[date] : index === 0 })),
    [],
  );

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Text style={[styles.title, rtlText]}>{t.tabComparisons}</Text>
          <Text style={styles.count}>{rows.length ? `${rows.length} ${t.shownCount}` : ''}</Text>
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
              <Text style={styles.emptyIcon}>🖼️</Text>
              <Text style={styles.emptyTitle}>{t.noComparisons}</Text>
              <Text style={[styles.emptyText, rtlText]}>{t.noComparisonsBody}</Text>
            </View>
          )
        }
        renderItem={({ item: group, index }) => (
          <DayGroup
            group={group}
            open={isOpen(group.date, index)}
            onToggle={() => toggle(group.date, index)}
            onOpen={(id) => router.push(`/comparison/${id}`)}
            t={t}
            rtlRow={rtlRow}
            rtlText={rtlText}
          />
        )}
      />
    </View>
  );
}

function DayGroup({ group, open, onToggle, onOpen, t, rtlRow, rtlText }) {
  const spin = useRef(new Animated.Value(open ? 1 : 0)).current;

  // Only the chevron animates. LayoutAnimation would be the obvious way to grow
  // the section, but it needs an Android opt-in flag and is unreliable under the
  // New Architecture that SDK 54 enables by default.
  const press = () => {
    Animated.timing(spin, {
      toValue: open ? 0 : 1,
      duration: 160,
      useNativeDriver: true,
    }).start();
    onToggle();
  };

  return (
    <View style={styles.group}>
      <Pressable onPress={press} style={[styles.groupHead, rtlRow]}>
        <Animated.View
          style={{
            transform: [
              { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] }) },
            ],
          }}
        >
          <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
        </Animated.View>
        <Text style={[styles.groupTitle, rtlText]}>{formatGroupDate(group.date, t)}</Text>
        <Text style={styles.groupCount}>{group.items.length}</Text>
      </Pressable>

      {open
        ? group.items.map((item) => {
            const band = BAND_COLOR[item.match_level] || BAND_COLOR.unknown;
            return (
              <Pressable
                key={item.id}
                onPress={() => onOpen(item.id)}
                style={({ pressed }) => [styles.row, rtlRow, pressed && styles.pressed]}
              >
                <View style={styles.rowText}>
                  <View style={[styles.rowTop, rtlRow]}>
                    <Text style={[styles.rowTitle, rtlText]} numberOfLines={1}>
                      {relationName(item.slot_id) || t.round}
                    </Text>
                    <Text style={styles.rowTime}>{formatTime(item.started_at)}</Text>
                  </View>
                  <View style={[styles.rowMetaRow, rtlRow]}>
                    <Text style={[styles.rowMeta, rtlText]}>
                      {`${item.shot_count} ${
                        item.shot_count === 1 ? t.photographOne : t.photographMany
                      }`}
                    </Text>
                    {/* Only where there is a real score. An unscored round
                        showing 0% would read as the worst possible result
                        rather than as no result. */}
                    {item.matched_at !== false && item.match_level !== 'unknown' ? (
                      <Text style={[styles.rowScore, { color: band }]}>{`${item.match_score}%`}</Text>
                    ) : null}
                    <View style={[styles.dot, { backgroundColor: band }]} />
                    <Text style={[styles.rowVerdict, { color: band }]} numberOfLines={1}>
                      {t[BAND_KEY[item.match_level] || 'matchUnknown']}
                    </Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </Pressable>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    // GradientBackground defaults to flex:1, which here would make this header
    // eat the whole screen. It must be `flex: 0`, not flexGrow/flexShrink of 0:
    // React Native expands `flex: 1` to flexBasis 0, so zeroing only grow and
    // shrink leaves a base height of zero and collapses the header to its
    // padding. `flex: 0` resets flexBasis to auto, so it sizes to its content.
    flex: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 22, fontWeight: '700', color: colors.white, letterSpacing: -0.4 },
  count: { fontSize: 12, fontWeight: '600', color: colors.onGradientMuted },

  body: { padding: spacing.xl, gap: spacing.md },
  spinner: { marginTop: spacing.xxxl },

  group: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  groupTitle: { ...typography.heading, flex: 1 },
  groupCount: { ...typography.caption },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pressed: { backgroundColor: colors.surfaceAlt },
  rowText: { flex: 1, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { ...typography.body, flex: 1 },
  rowTime: { ...typography.caption },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowMeta: { ...typography.caption },
  rowScore: { fontSize: 13, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowVerdict: { ...typography.caption, flexShrink: 1 },

  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.heading },
  emptyText: { ...typography.caption, textAlign: 'center', paddingHorizontal: spacing.xl },
});
