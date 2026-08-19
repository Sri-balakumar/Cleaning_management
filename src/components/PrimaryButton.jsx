import React, { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme';
export function PrimaryButton({
  label,
  onPress,
  loading = false,
  disabled = false,
  icon,
  variant = 'gradient',
  style,
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const inert = disabled || loading;
  const press = (to) =>
    Animated.spring(scale, {
      toValue: to,
      useNativeDriver: true,
      speed: 40,
      bounciness: 4,
    }).start();
  const content = (
    <>
      {loading ? (
        <ActivityIndicator color={variant === 'gradient' ? colors.white : colors.primary} />
      ) : (
        <>
          <Text
            style={[
              styles.label,
              variant !== 'gradient' && styles.labelAlt,
              variant === 'danger' && styles.labelDanger,
            ]}
          >
            {label}
          </Text>
          {icon ? (
            <Ionicons
              name={icon}
              size={18}
              color={
                variant === 'gradient'
                  ? colors.white
                  : variant === 'danger'
                    ? colors.danger
                    : colors.primary
              }
              style={styles.icon}
            />
          ) : null}
        </>
      )}
    </>
  );
  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: inert, busy: loading }}
        onPress={onPress}
        onPressIn={() => !inert && press(0.97)}
        onPressOut={() => press(1)}
        disabled={inert}
        style={inert ? styles.inert : undefined}
      >
        {variant === 'gradient' ? (
          <LinearGradient
            colors={colors.gradientButton}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.base, styles.gradient, inert && styles.flat]}
          >
            {content}
          </LinearGradient>
        ) : (
          <Animated.View style={[styles.base, variant === 'danger' ? styles.danger : styles.ghost]}>
            {content}
          </Animated.View>
        )}
      </Pressable>
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  base: {
    height: 54,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  gradient: {
    // Android draws the elevation shadow off a solid backing behind the view.
    // A LinearGradient carries no background of its own, so that backing showed
    // through as white inside the rounded corners. Painting the base colour
    // underneath - and clipping to the radius - leaves nothing white to show.
    backgroundColor: colors.primary,
    overflow: 'hidden',
    // A lift, not a glow - the old one bled indigo across the white card.
    shadowColor: colors.primaryDark,
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  ghost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  danger: { backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: colors.dangerBorder },
  inert: { opacity: 0.55 },
  // Goes on with `inert`. Fading the button puts it and its elevation shadow
  // into one composited layer, and the shadow then paints as a pale band
  // straight across the face rather than as a drop behind it. The solid
  // variants never showed it because they carry no elevation. A button nobody
  // can press has no business looking raised anyway.
  flat: { shadowOpacity: 0, elevation: 0 },
  label: { fontSize: 16, fontWeight: '700', color: colors.white, letterSpacing: 0.2 },
  labelAlt: { color: colors.primary },
  labelDanger: { color: colors.danger },
  icon: { marginLeft: spacing.sm },
});
