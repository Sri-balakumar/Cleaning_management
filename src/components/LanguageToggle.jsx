import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n/LanguageProvider';
import { LANGUAGES } from '../i18n/translations';
import { colors, radius, spacing } from '../theme';

/**
 * EN / عربي pill.
 *
 * Each option is always shown in its own script rather than translated, so
 * somebody who cannot read the current language can still find their own.
 *
 * `onGradient` styles it for the coloured header; the default suits a white
 * surface.
 */
export function LanguageToggle({ onGradient = false, compact = false }) {
  const { lang, setLang } = useT();

  return (
    <View style={[styles.wrap, onGradient ? styles.wrapOnGradient : styles.wrapOnSurface]}>
      {LANGUAGES.map((option) => {
        const active = option.code === lang;
        return (
          <Pressable
            key={option.code}
            onPress={() => setLang(option.code)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option.label}
            style={[
              styles.option,
              compact && styles.optionCompact,
              active && (onGradient ? styles.activeOnGradient : styles.activeOnSurface),
            ]}
          >
            <Text
              style={[
                styles.label,
                compact && styles.labelCompact,
                onGradient ? styles.labelOnGradient : styles.labelOnSurface,
                active && (onGradient ? styles.labelActiveOnGradient : styles.labelActiveOnSurface),
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', borderRadius: radius.pill, padding: 3, alignSelf: 'center' },
  wrapOnGradient: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  wrapOnSurface: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  option: { paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, borderRadius: radius.pill },
  optionCompact: { paddingHorizontal: spacing.lg, paddingVertical: 5 },
  activeOnGradient: { backgroundColor: colors.white },
  activeOnSurface: { backgroundColor: colors.primary },
  label: { fontSize: 13, fontWeight: '700' },
  labelCompact: { fontSize: 12 },
  labelOnGradient: { color: colors.onGradientMuted },
  labelOnSurface: { color: colors.textSecondary },
  labelActiveOnGradient: { color: colors.primary },
  labelActiveOnSurface: { color: colors.white },
});
