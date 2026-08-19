import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import {
  WEEKDAYS,
  createSlot,
  deleteSlot,
  fetchConfig,
  fetchSlots,
  formatFloatTime,
  writeSlot,
} from '../../src/api/config';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { useDialog } from '../../src/components/AppDialog';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { NumberRow, SelectRow, TextRow, TimeRow } from '../../src/components/SettingRows';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';

const PERIOD_KEYS = {
  morning: 'periodMorning',
  afternoon: 'periodAfternoon',
  evening: 'periodEvening',
  night: 'periodNight',
};

/** Which of the server's four periods a start hour falls in. */
function periodForHour(hour) {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

/** The web's own Days column: every day, none, or the ones that are on. */
function daysLabel(round, t) {
  const on = WEEKDAYS.filter((day) => round[day]);
  if (on.length === WEEKDAYS.length) return t.everyDay;
  if (!on.length) return t.noDays;
  return on.map((day) => t[`day_${day}`]).join(', ');
}

/**
 * The rounds, on their own screen.
 *
 * Its own screen rather than a section of Settings because that is where the
 * web keeps them: Configuration > Rounds is a menu of its own, next to
 * Settings rather than inside it. It opens as that list does -- name, period,
 * window, days, active -- and a row opens for editing where the web would
 * open a form.
 */
export default function RoundsConfigRoute() {
  return (
    <RequireAuth>
      <RoundsConfigScreen />
    </RequireAuth>
  );
}

function RoundsConfigScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();
  const { confirm } = useDialog();

  const [config, setConfig] = useState(null);
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // Which row is open for editing. One at a time, so the list stays a list.
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const cfg = await fetchConfig(connection.baseUrl);
      setConfig(cfg);
      setSlots(cfg ? (await fetchSlots(connection.baseUrl, cfg.id)) || [] : []);
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setLoading(false);
    }
  }, [connection, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every write goes through here so one place reports the server's refusal. */
  const run = useCallback(
    async (work) => {
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        await work();
        await load();
        setNotice(t.saved);
      } catch (e) {
        // The server's own wording: overlapping windows, a round with no
        // weekday, a window running past midnight. Far better than anything
        // generic.
        setError(translateError(t, AppError.from(e)));
      } finally {
        setSaving(false);
      }
    },
    [load, t],
  );

  const patchRound = (id, values) => run(() => writeSlot(connection.baseUrl, id, values));

  /**
   * A new round starts where the last one ended.
   *
   * Not a fixed 9:00 for every one of them: the second round added that way
   * overlaps the first and the server rightly refuses it. Following the last
   * round also means the period is read off a start hour that means something.
   */
  const addRound = () => {
    const last = slots.reduce((max, s) => Math.max(max, Number(s.hour_to) || 0), 0);
    const from = last > 0 && last <= 22 ? last : 9;
    return run(() =>
      createSlot(connection.baseUrl, {
        config_id: config.id,
        name: t.newRound,
        day_period: periodForHour(from),
        hour_from: from,
        hour_to: Math.min(from + 1, 24),
        mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false,
      }),
    );
  };

  const removeRound = (round) =>
    confirm({
      title: t.deleteRound,
      message: t.deleteRoundBody,
      icon: 'trash-outline',
      tone: 'danger',
      actions: [
        {
          label: t.delete,
          style: 'destructive',
          // A round with recordings against it is refused by the restrict rule
          // on the recording's slot_id; `run` shows that message unchanged.
          onPress: () => void run(() => deleteSlot(connection.baseUrl, round.id)),
        },
        { label: t.cancel, style: 'cancel' },
      ],
    });

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]}>{t.configRounds}</Text>
        </View>
      </GradientBackground>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: spacing.xxxl + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
        {error ? <ErrorBanner message={error} /> : null}
        {notice ? <ErrorBanner message={notice} tone="warning" /> : null}

        {/* No configuration at all is a different thing from no rounds, and
            adding a round is not the answer to it. */}
        {!loading && !config ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🧹</Text>
            <Text style={styles.emptyTitle}>{t.nothingSetUp}</Text>
          </View>
        ) : null}

        {config ? (
          <>
            {slots.length ? null : <Text style={[styles.emptyText, rtlText]}>{t.noRounds}</Text>}

            {slots.map((round) => (
              <RoundRow
                key={round.id}
                round={round}
                open={openId === round.id}
                onToggleOpen={() => setOpenId((id) => (id === round.id ? null : round.id))}
                onPatch={patchRound}
                onRemove={removeRound}
                disabled={saving}
              />
            ))}

            <PrimaryButton
              label={t.addRound}
              icon="add"
              variant="ghost"
              onPress={addRound}
              disabled={saving}
              style={styles.addBtn}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * One round: the list line the web shows, and the editor underneath it.
 *
 * Archived rounds are listed too, faded, rather than vanishing the moment the
 * Active switch goes off -- there is no Archived filter here to find them
 * again with, so hiding them would make that switch a one-way door.
 */
function RoundRow({ round, open, onToggleOpen, onPatch, onRemove, disabled }) {
  const { t, rtlRow, rtlText } = useT();
  const active = round.active !== false;

  // The typed fields, held until Save. Times, period and weekdays are single
  // taps and go straight through; a name or a note typed a character at a time
  // would otherwise be a write per keystroke.
  const [draft, setDraft] = useState({
    name: round.name || '',
    note: round.note || '',
    sequence: String(round.sequence ?? ''),
  });
  const edit = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const dirty =
    draft.name !== (round.name || '') ||
    draft.note !== (round.note || '') ||
    draft.sequence !== String(round.sequence ?? '');

  // In here rather than at module scope so the labels follow the language.
  const periods = useMemo(
    () => [
      { value: 'morning', label: t.periodMorning },
      { value: 'afternoon', label: t.periodAfternoon },
      { value: 'evening', label: t.periodEvening },
      { value: 'night', label: t.periodNight },
    ],
    [t],
  );

  const period = PERIOD_KEYS[round.day_period] ? t[PERIOD_KEYS[round.day_period]] : '';

  return (
    <View style={[styles.round, !active && styles.roundOff]}>
      {/* The switch is a sibling of the press target, not inside it: tapping
          Active must not also open the round. */}
      <View style={[styles.line, rtlRow]}>
        <Pressable
          onPress={onToggleOpen}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.lineText, rtlRow, pressed && styles.pressed]}
        >
          <View style={styles.lineCol}>
            <Text style={[styles.name, rtlText]} numberOfLines={1}>
              {round.name}
            </Text>
            <Text style={[styles.meta, rtlText]} numberOfLines={1}>
              {`${period ? `${period} · ` : ''}${formatFloatTime(
                round.hour_from,
              )} → ${formatFloatTime(round.hour_to)}`}
            </Text>
            <Text style={[styles.meta, rtlText]} numberOfLines={1}>
              {daysLabel(round, t)}
            </Text>
          </View>

          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.textMuted}
          />
        </Pressable>

        <Switch
          value={active}
          onValueChange={(v) => onPatch(round.id, { active: v })}
          disabled={disabled}
          trackColor={{ true: colors.primary, false: colors.borderStrong }}
          thumbColor={colors.white}
        />
      </View>

      {open ? (
        <View style={styles.editor}>
          <TextRow
            label={t.roundName}
            value={draft.name}
            onChange={(v) => edit({ name: v })}
            placeholder={t.roundName}
          />

          <SelectRow
            label={t.dayPeriod}
            value={round.day_period}
            options={periods}
            onChange={(v) => onPatch(round.id, { day_period: v })}
          />
          <TimeRow
            label={t.startsAt}
            value={round.hour_from}
            onChange={(v) => onPatch(round.id, { hour_from: v })}
          />
          <TimeRow
            label={t.endsAt}
            value={round.hour_to}
            onChange={(v) => onPatch(round.id, { hour_to: v })}
          />

          {/* The server works this out from the two times above; it is here to
              be read, the way the web shows it, not to be set. */}
          <View style={[styles.readonly, rtlRow]}>
            <Text style={[styles.hint, rtlText]}>{t.windowLength}</Text>
            <Text style={styles.readonlyValue}>
              {`${Math.round(Number(round.duration_minutes) || 0)} ${t.unitMinutes}`}
            </Text>
          </View>

          <View style={styles.daysBlock}>
            <Text style={[styles.label, rtlText]}>{t.weekdays}</Text>
            <View style={[styles.days, rtlRow]}>
              {WEEKDAYS.map((day) => {
                const on = !!round[day];
                return (
                  <Pressable
                    key={day}
                    onPress={() => onPatch(round.id, { [day]: !on })}
                    disabled={disabled}
                    style={[styles.day, on && styles.dayOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.dayText, on && styles.dayTextOn]}>{t[`day_${day}`]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <NumberRow
            label={t.roundOrder}
            value={draft.sequence}
            onChange={(v) => edit({ sequence: v })}
          />
          <TextRow
            label={t.roundInstructions}
            hint={t.roundInstructionsHint}
            value={draft.note}
            onChange={(v) => edit({ note: v })}
            multiline
            last
          />

          <PrimaryButton
            label={t.save}
            icon="save-outline"
            onPress={() =>
              onPatch(round.id, {
                name: draft.name,
                note: draft.note,
                sequence: Number(draft.sequence) || 0,
              })
            }
            disabled={disabled || !dirty}
            style={styles.saveBtn}
          />
          <PrimaryButton
            label={t.delete}
            icon="trash-outline"
            variant="danger"
            onPress={() => onRemove(round)}
            disabled={disabled}
            style={styles.deleteBtn}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    // GradientBackground defaults to flex:1, which here would make this header
    // eat the whole screen.
    flex: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: 20, fontWeight: '700', color: colors.white, letterSpacing: -0.3 },

  body: { padding: spacing.xl, gap: spacing.md },
  spinner: { marginTop: spacing.xxxl },
  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.title },
  emptyText: { ...typography.caption, paddingBottom: spacing.sm },

  round: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  roundOff: { opacity: 0.55 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  lineText: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  lineCol: { flex: 1, gap: 2 },
  name: { ...typography.body, fontWeight: '700' },
  meta: { ...typography.caption },
  pressed: { opacity: 0.65 },

  editor: { borderTopWidth: 1, borderTopColor: colors.border },
  saveBtn: { marginTop: spacing.md },
  deleteBtn: { marginVertical: spacing.md },
  hint: { ...typography.caption, fontSize: 11 },
  readonly: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  readonlyValue: { fontSize: 14, fontWeight: '700', color: colors.text },
  daysBlock: { paddingVertical: spacing.lg, gap: spacing.sm },
  days: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  day: {
    width: 38,
    height: 34,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  dayTextOn: { color: colors.white },

  addBtn: { marginBottom: spacing.md },
  label: { ...typography.label },
});
