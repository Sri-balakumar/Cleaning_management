import React, { forwardRef, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, typography } from '../theme';
export const AppTextField = forwardRef(function AppTextField(
  {
    label,
    icon,
    error,
    hint,
    detail,
    status = 'idle',
    secureToggle = false,
    onFocus,
    onBlur,
    ...inputProps
  },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(secureToggle);
  const focus = useRef(new Animated.Value(0)).current;
  const animate = (to) =>
    // Colours cannot be driven natively, hence useNativeDriver: false.
    Animated.timing(focus, { toValue: to, duration: 160, useNativeDriver: false }).start();
  const borderColor = useMemo(
    () =>
      error
        ? colors.dangerBorder
        : focus.interpolate({ inputRange: [0, 1], outputRange: [colors.border, colors.primary] }),
    [error, focus],
  );
  const backgroundColor = focus.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.surfaceAlt, colors.surface],
  });
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>

      <Animated.View
        style={[
          styles.field,
          { borderColor, backgroundColor },
          focused && !error ? styles.fieldFocused : null,
        ]}
      >
        <Ionicons
          name={icon}
          size={19}
          color={error ? colors.danger : focused ? colors.primary : colors.textMuted}
        />

        <TextInput
          ref={ref}
          style={styles.input}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={secureToggle ? hidden : inputProps.secureTextEntry}
          onFocus={(e) => {
            setFocused(true);
            animate(1);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            animate(0);
            onBlur?.(e);
          }}
          {...inputProps}
        />

        {status === 'checking' ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        {status === 'valid' ? (
          <Ionicons name="checkmark-circle" size={20} color={colors.success} />
        ) : null}

        {secureToggle ? (
          <Pressable
            onPress={() => setHidden((v) => !v)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
          >
            <Ionicons
              name={hidden ? 'eye-outline' : 'eye-off-outline'}
              size={20}
              color={colors.textMuted}
            />
          </Pressable>
        ) : null}
      </Animated.View>

      {error ? (
        <>
          <Text style={styles.error}>{error}</Text>
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        </>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
});
const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: { ...typography.label, marginBottom: spacing.sm },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: 54,
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  fieldFocused: {
    shadowColor: colors.primary,
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
    // Removes Android's default vertical padding so text centres in the row.
    paddingVertical: 0,
  },
  error: { fontSize: 12, fontWeight: '600', color: colors.danger, marginTop: spacing.sm },
  detail: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
    marginTop: 2,
    lineHeight: 15,
  },
  hint: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    marginTop: spacing.sm,
    lineHeight: 16,
  },
});
