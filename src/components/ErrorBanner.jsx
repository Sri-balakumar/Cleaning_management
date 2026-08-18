import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme';
/** A tone is a colour set plus the icon that goes with it. */
const TONES = {
  danger: {
    fill: colors.dangerBg,
    edge: colors.dangerBorder,
    ink: colors.danger,
    icon: 'alert-circle',
  },
  warning: {
    fill: colors.warningBg,
    edge: colors.warningBorder,
    ink: colors.warning,
    icon: 'information-circle',
  },
  success: {
    fill: colors.successBg,
    edge: colors.successBorder,
    ink: colors.success,
    icon: 'checkmark-circle',
  },
};

export function ErrorBanner({ message, tone = 'danger' }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: message ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [message, opacity]);
  if (!message) return null;
  const { fill, edge, ink, icon } = TONES[tone] ?? TONES.danger;
  return (
    <Animated.View
      style={[styles.banner, { opacity, backgroundColor: fill, borderColor: edge }]}
    >
      <Ionicons name={icon} size={18} color={ink} />
      <View style={styles.textWrap}>
        <Text style={[styles.text, { color: ink }]}>{message}</Text>
      </View>
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  textWrap: { flex: 1 },
  text: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
});
