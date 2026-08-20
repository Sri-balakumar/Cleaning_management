import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, spacing } from '../theme';

/**
 * How far past a view's bearing counts as having swept it.
 *
 * The same figure DirectionCapture allows for facing one: nobody turns exactly
 * ninety degrees, and holding out for it would leave the last view permanently
 * one nudge short of ticked.
 */
export const SWEEP_TOLERANCE = 20;

/**
 * The views of a round, as a row of chips, with two different marks on them.
 *
 * `activeIndex` is the clock saying **face this way now** - the round's seconds
 * shared out evenly between the views. `turnedBy` is the gyroscope saying **you
 * actually turned past this one**, and is left out where there is nothing
 * turning: on playback nobody is holding the phone up, so the review screen
 * passes no sensor value and shows the highlight alone.
 *
 * Drawn from `marks`, which the caller works out from the server's turn
 * figures. Nothing here calculates a bearing, for the same reason
 * DirectionCapture does not: which views a round walks, and how far apart they
 * sit, is the server's answer.
 */
export function SweepChips({
  marks,
  activeIndex = -1,
  turnedBy = null,
  onSelect = null,
  canSelect = null,
}) {
  if (!marks.length) return null;

  return (
    <View style={styles.sweep}>
      {marks.map((mark, position) => {
        const done = turnedBy !== null && turnedBy >= mark.at - SWEEP_TOLERANCE;
        const now = position === activeIndex;
        // Shown but dead where the clip never got this far. Hiding it would
        // read as a round that has fewer views than it does; dimming it says
        // "this one exists, and this recording does not reach it".
        const reachable = !canSelect || canSelect(position);
        // A plain View while filming, where there is nothing to jump to, and a
        // button on playback, where the obvious gesture is to tap the wall you
        // want to see.
        const Chip = onSelect && reachable ? Pressable : View;
        return (
          <Chip
            key={mark.key}
            onPress={onSelect && reachable ? () => onSelect(position) : undefined}
            accessibilityRole={onSelect && reachable ? 'button' : undefined}
            accessibilityLabel={onSelect && reachable ? mark.label : undefined}
            accessibilityState={onSelect ? { disabled: !reachable } : undefined}
            style={({ pressed } = {}) => [
              styles.chip,
              done && styles.chipDone,
              now && styles.chipNow,
              !reachable && styles.chipUnreached,
              pressed && styles.chipPressed,
            ]}
          >
            <Ionicons
              name={done ? 'checkmark-circle' : now ? 'locate' : 'ellipse-outline'}
              size={13}
              color={done ? colors.success : now ? colors.white : colors.onGradientMuted}
            />
            <Text
              style={[styles.text, done && styles.textDone, now && styles.textNow]}
              numberOfLines={1}
            >
              {mark.label}
            </Text>
          </Chip>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  sweep: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(15,23,42,0.6)',
    maxWidth: '46%',
  },
  chipDone: { backgroundColor: 'rgba(16,185,129,0.22)' },
  chipPressed: { opacity: 0.6 },
  // Faded, not hidden: the view is part of the round, this recording simply
  // never reached it.
  chipUnreached: { opacity: 0.35 },
  // Filled rather than tinted: this is the one chip somebody glancing down
  // mid-turn has to find, so it has to win against the other three.
  chipNow: { backgroundColor: colors.primary, borderColor: colors.primary },
  text: { fontSize: 12, fontWeight: '600', color: colors.onGradientMuted },
  textDone: { color: colors.white },
  textNow: { color: colors.white, fontWeight: '700' },
});
