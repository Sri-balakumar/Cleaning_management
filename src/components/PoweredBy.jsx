import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useT } from '../i18n/LanguageProvider';
import { colors, spacing, typography } from '../theme';

/** Read from app.json, so the label can never drift from the shipped build. */
const version = Constants.expoConfig?.version;

/**
 * Attribution line - "Powered by 369ai | v1.0.0" - with a hairline rule instead of
 * a pipe glyph, which sits off the baseline differently on iOS and Android at
 * caption size.
 *
 * Pass `onGradient` on screens that sit on the brand gradient.
 *
 * The same line on every screen that carries one. Login once showed the version
 * alone, on the grounds that the logo above it already said who made this - but
 * the attribution and the version are one credit, and reading them differently
 * in two places is the kind of small inconsistency people notice.
 */
export function PoweredBy({ onGradient, style }) {
  const { t } = useT();
  const textStyle = [styles.text, onGradient ? styles.textOnGradient : null];

  return (
    <View style={[styles.row, style]}>
      <Text style={textStyle}>{t.poweredBy}</Text>
      {version ? (
        <>
          <View style={[styles.rule, onGradient ? styles.ruleOnGradient : null]} />
          <Text style={textStyle}>v{version}</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  text: typography.caption,
  textOnGradient: { color: colors.onGradientMuted },
  rule: {
    width: 1,
    height: 10,
    marginHorizontal: spacing.sm,
    backgroundColor: colors.borderStrong,
  },
  ruleOnGradient: { backgroundColor: colors.glassBorder },
});
