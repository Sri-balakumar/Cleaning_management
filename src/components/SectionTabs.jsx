import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing } from '../theme';

/**
 * The pills that pick one section of a settings screen.
 *
 * Deliberately the same shape as the language pill: rounded track, filled
 * capsule on the selected one. Two different pill designs on the same screen
 * would read as two different controls.
 *
 * They WRAP onto a second line rather than scrolling sideways. A horizontal
 * ScrollView settled on a content width during the first layout pass, before
 * its labels had measured theirs, so every pill came up clipped until something
 * forced a second pass - which is exactly why moving between sections appeared
 * to fix it. A wrapping row asks no question about width at all: each pill
 * takes the room its own text needs. It also puts all of them on screen at
 * once, so no tab has to be scrolled into view to be found.
 *
 * `tabs` is `[{ key, label }]`.
 */
export function SectionTabs({ tabs, value, onChange }) {
  const { rtlRow } = useT();

  return (
    <View style={[styles.strip, rtlRow]}>
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.pill, active && styles.pillActive]}
          >
            {/* No numberOfLines: nothing here may ever be ellipsised. The
                label is the only clue to what is behind the tab. */}
            <Text style={[styles.label, active && styles.labelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
  },
  pill: {
    // Belt to the wrapping's braces: a pill sizes to its own text and is never
    // squeezed to help a row fit. Without it the last pill on a line shrinks
    // instead of moving down to the next one.
    flexShrink: 0,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  label: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  labelActive: { color: colors.white },
});
