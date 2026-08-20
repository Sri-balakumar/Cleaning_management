import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing } from '../theme';

/**
 * Photos or video, chosen by the person holding the phone.
 *
 * Sits over the camera the way a phone's own camera app puts its mode switch
 * there, because that is where somebody looks for it: the decision is made
 * while looking at the room, not on a settings screen a manager owns.
 *
 * It reports the choice and nothing else. Which screen that mounts, and what
 * happens to anything already captured, is the recorder's business - see
 * `switchMode` there. Keeping that out of here is what lets the same control
 * sit on the ready screen and over both cameras without three copies of the
 * rules.
 */
const OPTIONS = [
  { key: 'photographs', icon: 'camera', label: 'capturePhotos' },
  { key: 'video', icon: 'videocam', label: 'captureVideo' },
];

export function CaptureModeSwitch({ value, onChange, disabled, style }) {
  const { t } = useT();

  return (
    <View style={[styles.wrap, style]}>
      {OPTIONS.map((option) => {
        const active = value === option.key;
        return (
          <Pressable
            key={option.key}
            // A tap on the one already chosen is not a change. Letting it
            // through would put the discard question in front of somebody who
            // had not asked for anything.
            onPress={() => !active && !disabled && onChange(option.key)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled: !!disabled }}
            accessibilityLabel={t[option.label]}
            style={[styles.tab, active && styles.tabOn]}
          >
            <Ionicons
              name={option.icon}
              size={16}
              color={active ? colors.primary : colors.white}
            />
            <Text style={[styles.text, active && styles.textOn]} numberOfLines={1}>
              {t[option.label]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignSelf: 'center',
    padding: 3,
    borderRadius: radius.pill,
    // Dark and translucent: this is drawn over a live preview, and a solid
    // panel would hide the part of the room somebody is trying to frame.
    backgroundColor: 'rgba(15,23,42,0.6)',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
  },
  tabOn: { backgroundColor: colors.white },
  text: { fontSize: 13, fontWeight: '700', color: colors.white },
  textOn: { color: colors.primary },
});
