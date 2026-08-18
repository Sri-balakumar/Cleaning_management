import React, { useState } from 'react';
import { Image, StyleSheet, Text } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme';
function initials(name) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
export function Avatar({ name, base64, size = 56, ring = false }) {
  const [failed, setFailed] = useState(false);
  const box = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };
  const ringStyle = ring
    ? { borderWidth: Math.max(2, size * 0.045), borderColor: colors.glassBorder }
    : null;
  if (base64 && !failed) {
    return (
      <Image
        source={{ uri: `data:image/png;base64,${base64}` }}
        style={[box, ringStyle, styles.image]}
        onError={() => setFailed(true)}
        accessibilityLabel={name ? `${name}'s photo` : 'Profile photo'}
      />
    );
  }
  return (
    <LinearGradient
      colors={colors.gradientAvatar}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[box, ringStyle, styles.center]}
    >
      <Text style={[styles.initials, { fontSize: size * 0.36 }]}>{initials(name)}</Text>
    </LinearGradient>
  );
}
const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  image: { backgroundColor: colors.surfaceAlt, resizeMode: 'cover' },
  initials: { color: colors.white, fontWeight: '700', letterSpacing: 0.5 },
});
