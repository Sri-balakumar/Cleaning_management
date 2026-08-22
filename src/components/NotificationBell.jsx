import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

/**
 * The bell, and how many low rounds have not been read.
 *
 * Deliberately drawn only for a manager and only by a caller that has already
 * checked. It is not access control -- the server answers a non-manager with
 * an empty feed and a zero count whatever the interface does -- but a bell
 * with nothing behind it is worse than no bell.
 *
 * The count is capped at 99+. A three-digit badge is wider than the icon it
 * sits on, and the difference between 100 and 140 unread changes nobody's next
 * move: both mean "this got away from us".
 *
 * Filled when there is something to read, outlined when there is not. The same
 * cue the tab bar uses, so the two agree about what "active" looks like.
 */
export function NotificationBell({ count = 0, onPress, accessibilityLabel }) {
  const unread = count > 0;
  const label = count > 99 ? '99+' : String(count);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // Announced rather than left to the badge alone: a screen reader gets
      // "Low rounds, 3 unread" instead of a bell and a loose number.
      accessibilityValue={unread ? { text: label } : undefined}
      style={styles.wrap}
    >
      <Ionicons
        name={unread ? 'notifications' : 'notifications-outline'}
        size={22}
        color={colors.white}
      />
      {unread ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  badge: {
    position: 'absolute',
    // Sits on the bell's top-right corner rather than beside it, so the
    // control stays one icon wide however big the number gets.
    top: -5,
    right: -8,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    // A ring in the header colour, so the badge reads as separate from the
    // bell rather than as part of the glyph.
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  badgeText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 13,
  },
});
