import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';
import { formatCountdown } from '../cleaning/useSlotClock';
import { PrimaryButton } from './PrimaryButton';

const STATUS = {
  done: { key: 'statusRecorded', color: colors.success, bg: colors.successBg },
  open: { key: 'statusOpenNow', color: colors.primary, bg: '#EEF2FF' },
  upcoming: { key: 'statusUpcoming', color: colors.textSecondary, bg: colors.surfaceAlt },
  missed: { key: 'statusMissed', color: colors.danger, bg: colors.dangerBg },
};

export function RoundCard({ round, countdown, pending, canRecord, onRecord, onWatch }) {
  const { t, rtlRow, rtlText } = useT();
  const status = STATUS[round.state] ?? STATUS.upcoming;
  const untilOpen = countdown ? countdown.untilOpen : round.seconds_until_open;
  const untilClose = countdown ? countdown.untilClose : round.seconds_until_close;

  return (
    <View style={styles.card}>
      <View style={[styles.head, rtlRow]}>
        <View style={styles.headText}>
          <Text style={[styles.name, rtlText]}>{round.name}</Text>
          <View style={[styles.window, rtlRow]}>
            <Ionicons name="time-outline" size={13} color={colors.textMuted} />
            <Text style={[styles.windowText, rtlText]}>{round.window_label}</Text>
          </View>
        </View>
        <View style={[styles.badge, { backgroundColor: status.bg }]}>
          <Text style={[styles.badgeText, { color: status.color }]}>{t[status.key]}</Text>
        </View>
      </View>

      {round.note ? <Text style={[styles.note, rtlText]}>{round.note}</Text> : null}

      {round.state === 'done' ? (
        <View style={styles.body}>
          <View style={[styles.line, rtlRow]}>
            <Ionicons name="checkmark-circle" size={16} color={colors.success} />
            <Text style={[styles.lineText, rtlText]}>
              {t.recordedBy} <Text style={styles.strong}>{round.recorded_by}</Text>
            </Text>
          </View>
          {/*
            can_view, not just "there is a recording": a round done by a
            colleague shows as done to everybody, but only its owner and a
            manager may open it. Offering anyone else this button would only
            ever give them a permission error.
          */}
          {round.can_view ? (
            <PrimaryButton
              label={t.watch}
              icon="play"
              variant="ghost"
              onPress={() => onWatch(round)}
              style={styles.action}
            />
          ) : null}
        </View>
      ) : pending ? (
        // The local countdown ran out. The server has the final say, so wait
        // for it rather than enabling the button on the phone's own clock.
        <View style={styles.body}>
          <View style={[styles.pending, rtlRow]}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={[styles.lineText, rtlText]}>{t.opening}</Text>
          </View>
          <Text style={[styles.hint, rtlText]}>{t.checkingWithServer}</Text>
        </View>
      ) : round.state === 'open' ? (
        <View style={styles.body}>
          <Text style={[styles.lineText, rtlText]}>
            {t.closesIn} <Text style={styles.strong}>{formatCountdown(untilClose, t)}</Text>
          </Text>
          {canRecord ? (
            <PrimaryButton
              label={t.captureNow}
              icon="camera"
              onPress={() => onRecord(round)}
              style={styles.action}
            />
          ) : (
            <View style={[styles.blocked, rtlRow]}>
              <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
              <Text style={[styles.hint, rtlText]}>{t.cannotRecordThisRound}</Text>
            </View>
          )}
        </View>
      ) : round.state === 'upcoming' ? (
        <View style={styles.body}>
          <Text style={[styles.lineText, rtlText]}>
            {t.opensIn} <Text style={styles.strong}>{formatCountdown(untilOpen, t)}</Text>
          </Text>
          <PrimaryButton
            label={t.capture}
            icon="camera"
            disabled
            onPress={() => {}}
            variant="ghost"
            style={styles.action}
          />
        </View>
      ) : (
        <View style={styles.body}>
          <View style={[styles.line, rtlRow]}>
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={[styles.lineText, styles.danger, rtlText]}>{t.roundNotRecorded}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headText: { flex: 1 },
  name: { fontSize: 16, fontWeight: '700', color: colors.text },
  window: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  windowText: { ...typography.caption },
  badge: { borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: spacing.md },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  note: { ...typography.caption, marginTop: spacing.sm, lineHeight: 17 },
  body: { marginTop: spacing.md, gap: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  lineText: { fontSize: 14, fontWeight: '500', color: colors.textSecondary },
  strong: { fontWeight: '700', color: colors.text },
  danger: { color: colors.danger },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  blocked: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  hint: { ...typography.caption },
  action: { marginTop: spacing.xs },
});
