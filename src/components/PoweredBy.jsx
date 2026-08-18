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
 * `versionOnly` drops the attribution and keeps the version. Login uses it,
 * because the company logo already sits at the top of that screen and repeating
 * the name below it says nothing new -- but the version still earns its place,
 * since it is what someone reads out when reporting a problem.
 */
export function PoweredBy({ onGradient, versionOnly, style }) {
  const { t } = useT();
  const textStyle = [styles.text, onGradient ? styles.textOnGradient : null];

  if (versionOnly) {
    return version ? (
      <View style={[styles.row, style]}>
        <Text style={textStyle}>v{version}</Text>
      </View>
    ) : null;
  }

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
