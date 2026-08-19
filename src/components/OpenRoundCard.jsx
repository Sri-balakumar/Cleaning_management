import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatCountdown } from '../cleaning/useSlotClock';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing } from '../theme';
import { GradientBackground, GradientOrbs } from './GradientBackground';
import { PrimaryButton } from './PrimaryButton';

/**
 * The single card at the top of the dashboard that says what to do now.
 *
 * `mode` is explicit rather than inferred, because the two payloads it is built
 * from are NOT the same shape:
 *
 *   'open' -> `active_slot`, assembled by get_dashboard_state with
 *             seconds_remaining / can_record / will_overrun
 *   'next' -> `next_slot`, a plain row from _slot_rows with seconds_until_open
 *   'done' -> no round at all, just today's totals
 *
 * Treating them as interchangeable is how a countdown ends up reading
 * `undefined`, so each mode reads only the fields its own payload carries.
 */
export function OpenRoundCard({ mode, round, countdown, capturesOnly, onRecord, denyMessage, done, total }) {
  const { t, rtlRow, rtlText } = useT();

  if (mode === 'done') {
    return (
      <GradientBackground style={styles.card}>
        <GradientOrbs />
        <View style={[styles.eyebrowRow, rtlRow]}>
          <Ionicons name="checkmark-circle" size={16} color="#4ADE80" />
          <Text style={styles.eyebrow}>{t.allDone}</Text>
        </View>
        <Text style={[styles.name, rtlText]}>
          {done}/{total}
        </Text>
        <Text style={[styles.window, rtlText]}>{t.allDoneBody}</Text>
      </GradientBackground>
    );
  }

  const isOpen = mode === 'open';
  // Live value where the clock has one, the payload's own figure until then.
  const seconds = isOpen
    ? (countdown ? countdown.untilClose : round.seconds_remaining)
    : (countdown ? countdown.untilOpen : round.seconds_until_open);

  return (
    <GradientBackground style={styles.card} soft={!isOpen}>
      <GradientOrbs />

      <View style={[styles.eyebrowRow, rtlRow]}>
        <View style={[styles.dot, !isOpen && styles.dotNext]} />
        <Text style={styles.eyebrow}>{isOpen ? t.openNow : t.upNext}</Text>
      </View>

      <Text style={[styles.name, rtlText]} numberOfLines={2}>
        {round.name}
      </Text>
      <Text style={[styles.window, rtlText]}>{round.window_label}</Text>

      <Text style={[styles.countdown, rtlText]}>
        {isOpen ? t.closesIn : t.opensIn}{' '}
        <Text style={styles.countdownValue}>{formatCountdown(seconds, t)}</Text>
      </Text>

      {/*
        The server flags this when the window is shorter than the configured
        clip. Its own note is that the button still works and the interface
        warns -- a short recording beats none at all.
      */}
      {isOpen && round.will_overrun ? (
        <View style={[styles.warning, rtlRow]}>
          <Ionicons name="warning-outline" size={15} color={colors.white} />
          <Text style={[styles.warningText, rtlText]}>{t.overrunWarning}</Text>
        </View>
      ) : null}

      {isOpen ? (
        round.can_record ? (
          <PrimaryButton
            label={capturesOnly ? t.captureNow : t.recordNow}
            icon={capturesOnly ? 'camera' : 'videocam'}
            variant="ghost"
            onPress={() => onRecord(round)}
            style={styles.action}
          />
        ) : (
          <View style={[styles.blocked, rtlRow]}>
            <Ionicons name="lock-closed" size={14} color={colors.onGradientMuted} />
            <Text style={[styles.blockedText, rtlText]}>
              {denyMessage || t.cannotRecordThisRound}
            </Text>
          </View>
        )
      ) : null}
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  card: {
    // GradientBackground defaults to flex:1 for full-screen use; here it is a
    // card and must size to its content.
    flex: 0,
    borderRadius: radius.xl,
    padding: spacing.xl,
    overflow: 'hidden',
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4ADE80' },
  dotNext: { backgroundColor: colors.onGradientMuted },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.1, color: colors.white },
  name: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.white,
    letterSpacing: -0.4,
    marginTop: spacing.md,
  },
  window: { fontSize: 13, fontWeight: '500', color: colors.onGradientMuted, marginTop: 2 },
  countdown: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onGradientMuted,
    marginTop: spacing.lg,
  },
  countdownValue: { fontWeight: '800', color: colors.white },
  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(217,119,6,0.32)',
    borderWidth: 1,
    borderColor: 'rgba(253,230,138,0.55)',
  },
  warningText: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.white, lineHeight: 17 },
  action: { marginTop: spacing.lg },
  blocked: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  blockedText: { flex: 1, fontSize: 13, fontWeight: '500', color: colors.onGradientMuted },
});
