import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme';
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
  const danger = tone === 'danger';
  return (
    <Animated.View
      style={[
        styles.banner,
        { opacity, backgroundColor: danger ? colors.dangerBg : colors.warningBg },
        { borderColor: danger ? colors.dangerBorder : colors.warningBorder },
      ]}
    >
      <Ionicons
        name={danger ? 'alert-circle' : 'information-circle'}
        size={18}
        color={danger ? colors.danger : colors.warning}
      />
      <View style={styles.textWrap}>
        <Text style={[styles.text, { color: danger ? colors.danger : colors.warning }]}>
          {message}
        </Text>
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
