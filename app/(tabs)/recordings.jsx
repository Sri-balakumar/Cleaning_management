import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import { deleteRecordings, fetchRecordings } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { useDialog } from '../../src/components/AppDialog';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';
import { log } from '../../src/utils/log';

/** The backend hands back naive UTC: "YYYY-MM-DD HH:MM:SS". */
function parseServerDate(value) {
  if (!value) return null;
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Clock time only -- the calendar date is the group header above it. */
function formatTime(value) {
  const parsed = parseServerDate(value);
  if (!parsed) return '';
  return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** `slot_date` is a plain "YYYY-MM-DD", with no timezone to reason about. */
function formatGroupDate(isoDate, t) {
  const [y, m, d] = (isoDate || '').split('-').map(Number);
  if (!y) return isoDate || '';
  const date = new Date(y, m - 1, d);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const today = new Date();
  if (sameDay(date, today)) return t.today;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return t.yesterday;

  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const relationName = (value) => (Array.isArray(value) ? value[1] : '');

// Selection fields come back as raw values, so their labels are mapped here.
const QUALITY_KEYS = { low: 'qualityLow', medium: 'qualityMedium', high: 'qualityHigh' };
const AI_KEYS = { not_run: 'aiNotRun', done: 'aiDone', failed: 'aiFailed' };

/**
 * Rows arrive ordered `slot_date desc, id desc`, so a single pass produces the
 * groups already in the right order -- no sorting, and no second request.
 */
function groupByDate(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.date !== row.slot_date) {
      current = { date: row.slot_date, items: [], sizeMb: 0 };
      groups.push(current);
    }
    current.items.push(row);
    current.sizeMb += row.file_size_mb || 0;
  }
  return groups;
}

export default function RecordingsRoute() {
  return (
    <RequireAuth>
      <RecordingsScreen />
    </RequireAuth>
  );
}

function RecordingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();
  const { confirm } = useDialog();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  // Empty set means normal browsing; entering selection puts an id in here.
  const [selected, setSelected] = useState([]);
  const [selecting, setSelecting] = useState(false);

  // Deleting is a manager's job; the ACL refuses unlink for everyone else, so
  // the interface only offers it when the server says this person may.
  const canManage = rows.some((r) => r.can_manage);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected([]);
  }, []);

  const toggleSelected = useCallback((id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const confirmDelete = useCallback(() => {
    if (!selected.length) return;
    confirm({
      title: t.deleteRecordings,
      // Says what deletion actually does, which is the reason for doing it.
      message: t.deleteRecordingsBody,
      icon: 'trash-outline',
      tone: 'danger',
      actions: [
        {
          label: t.delete,
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deleteRecordings(connection.baseUrl, selected);
                exitSelection();
                await load();
              } catch (e) {
                setError(translateError(t, AppError.from(e)));
              }
            })();
          },
        },
        { label: t.cancel, style: 'cancel' },
      ],
    });
  }, [confirm, connection, exitSelection, load, selected, t]);

  useEffect(() => {
    log('screen', 'recordings mounted');
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      // No role filter here: the server already decides whether this person
      // sees only their own recordings or everybody's.
      const result = await fetchRecordings(connection.baseUrl);
      setRows(result || []);
      log('recordings', `loaded ${(result || []).length} rows`);
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

  // The newest date is open unless it has been closed by hand: a fully
  // collapsed screen reads as empty, and today is what this tab is opened for.
  const isOpen = useCallback(
    (date, index) => (date in collapsed ? !collapsed[date] : index === 0),
    [collapsed],
  );

  const toggle = useCallback(
    (date, index) =>
      setCollapsed((prev) => ({
        ...prev,
        [date]: date in prev ? !prev[date] : index === 0,
      })),
    [],
  );

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        {/* Title and count share a row -- stacked, this block was far taller
            than the content it introduces. */}
        <View style={[styles.headerRow, rtlRow]}>
          {selecting ? (
            <>
              <Pressable onPress={exitSelection} hitSlop={12} accessibilityRole="button">
                <Ionicons name="close" size={22} color={colors.white} />
              </Pressable>
              <Text style={[styles.title, styles.titleSelecting, rtlText]}>
                {selected.length} {t.selectedCount}
              </Text>
              <Pressable
                onPress={confirmDelete}
                hitSlop={12}
                disabled={!selected.length}
                accessibilityRole="button"
                accessibilityLabel={t.delete}
                style={!selected.length && styles.disabled}
              >
                <Ionicons name="trash-outline" size={21} color={colors.white} />
              </Pressable>
            </>
          ) : (
            <>
              <Text style={[styles.title, rtlText]}>{t.recordings}</Text>
              <Text style={styles.count}>
                {rows.length ? `${rows.length} ${t.shownCount}` : ''}
              </Text>
            </>
          )}
        </View>
      </GradientBackground>

      <FlatList
        data={groups}
        style={styles.listFlex}
        keyExtractor={(group) => group.date}
        contentContainerStyle={styles.list}
        refreshing={loading}
        onRefresh={load}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={error ? <ErrorBanner message={error} /> : null}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🎬</Text>
              <Text style={styles.emptyTitle}>{t.nothingHereYet}</Text>
              <Text style={styles.emptyText}>{t.recordingsAppearOnce}</Text>
            </View>
          )
        }
        renderItem={({ item: group, index }) => (
          <DateGroup
            group={group}
            open={isOpen(group.date, index)}
            onToggle={() => toggle(group.date, index)}
            onOpenRecording={(id) =>
              selecting ? toggleSelected(id) : router.push(`/recording/${id}`)
            }
            onLongPressRecording={
              canManage
                ? (id) => {
                    setSelecting(true);
                    toggleSelected(id);
                  }
                : undefined
            }
            selecting={selecting}
            selected={selected}
            t={t}
            rtlRow={rtlRow}
            rtlText={rtlText}
          />
        )}
      />
    </View>
  );
}

function DateGroup({
  group,
  open,
  onToggle,
  onOpenRecording,
  onLongPressRecording,
  selecting,
  selected,
  t,
  rtlRow,
  rtlText,
}) {
  const spin = useRef(new Animated.Value(open ? 1 : 0)).current;

  // Only the chevron animates. LayoutAnimation would be the obvious way to
  // grow the section, but it needs an Android opt-in flag and is unreliable
  // under the New Architecture that SDK 54 enables by default.
  const press = () => {
    Animated.timing(spin, {
      toValue: open ? 0 : 1,
      duration: 160,
      useNativeDriver: true,
    }).start();
    onToggle();
  };

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });
  const count = group.items.length;

  return (
    <View style={styles.group}>
      <Pressable
        onPress={press}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.groupHead, rtlRow, pressed && styles.pressed]}
      >
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </Animated.View>
        <Text style={[styles.groupDate, rtlText]}>{formatGroupDate(group.date, t)}</Text>
        <Text style={styles.groupMeta}>
          {count} {count === 1 ? t.recordingOne : t.recordingMany}
          {group.sizeMb ? ` · ${group.sizeMb.toFixed(1)} MB` : ''}
        </Text>
      </Pressable>

      {open
        ? group.items.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => onOpenRecording(item.id)}
              onLongPress={
                onLongPressRecording ? () => onLongPressRecording(item.id) : undefined
              }
              style={({ pressed }) => [styles.row, rtlRow, pressed && styles.pressed]}
            >
              <View style={styles.thumb}>
                <Ionicons
                  name={
                    selecting
                      ? selected.includes(item.id)
                        ? 'checkbox'
                        : 'square-outline'
                      : 'play'
                  }
                  size={16}
                  color={colors.primary}
                />
              </View>

              <View style={styles.rowText}>
                <View style={[styles.rowTop, rtlRow]}>
                  <Text style={[styles.rowTitle, rtlText]} numberOfLines={1}>
                    {relationName(item.slot_id) || t.round}
                  </Text>
                  <Text style={styles.rowTime}>{formatTime(item.started_at)}</Text>
                </View>

                <Text style={[styles.rowMeta, rtlText]} numberOfLines={1}>
                  {relationName(item.user_id)}
                </Text>

                <Text style={[styles.rowMeta, rtlText]} numberOfLines={1}>
                  {item.duration_seconds}
                  {t.unitSecond}
                  {item.file_format ? ` · ${String(item.file_format).toUpperCase()}` : ''}
                  {QUALITY_KEYS[item.quality] ? ` · ${t[QUALITY_KEYS[item.quality]]}` : ''}
                  {item.file_size_mb ? ` · ${item.file_size_mb} MB` : ''}
                </Text>

                <View style={[styles.badges, rtlRow]}>
                  {AI_KEYS[item.ai_status] ? (
                    <View
                      style={[
                        styles.badge,
                        item.ai_status === 'done' && styles.badgeOk,
                        item.ai_status === 'failed' && styles.badgeBad,
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          item.ai_status === 'done' && styles.badgeTextOk,
                          item.ai_status === 'failed' && styles.badgeTextBad,
                        ]}
                      >
                        {t[AI_KEYS[item.ai_status]]}
                      </Text>
                    </View>
                  ) : null}
                  {item.truncated ? (
                    <View style={[styles.badge, styles.badgeWarn]}>
                      <Text style={[styles.badgeText, styles.badgeTextWarn]}>{t.cutShort}</Text>
                    </View>
                  ) : null}
                </View>
              </View>

              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          ))
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
  titleSelecting: { flex: 1, fontSize: 17 },
  disabled: { opacity: 0.4 },
  count: { fontSize: 12, fontWeight: '600', color: colors.onGradientMuted },

  listFlex: { flex: 1 },
  list: { padding: spacing.xl, gap: spacing.md },
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
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surfaceAlt,
  },
  groupDate: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  groupMeta: { ...typography.caption },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  pressed: { opacity: 0.65 },
  thumb: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  rowTime: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  rowMeta: { ...typography.caption },

  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 4 },
  badge: {
    borderRadius: radius.pill,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surfaceAlt,
  },
  badgeOk: { backgroundColor: colors.successBg },
  badgeBad: { backgroundColor: colors.dangerBg },
  badgeWarn: { backgroundColor: colors.warningBg },
  badgeText: { fontSize: 10, fontWeight: '700', color: colors.textMuted },
  badgeTextOk: { color: colors.success },
  badgeTextBad: { color: colors.danger },
  badgeTextWarn: { color: colors.warning },

  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.title },
  emptyText: { ...typography.caption, textAlign: 'center' },
});
