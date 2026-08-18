import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme';
export function GradientBackground({ children, style, soft }) {
  return (
    <LinearGradient
      colors={soft ? colors.gradientSoft : colors.gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.fill, style]}
    >
      {children}
    </LinearGradient>
  );
}
/** Decorative blurred blobs that give the flat gradient some depth. */
export function GradientOrbs() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.orb, styles.orbOne]} />
      <View style={[styles.orb, styles.orbTwo]} />
    </View>
  );
}
const styles = StyleSheet.create({
  fill: { flex: 1 },
  orb: { position: 'absolute', borderRadius: 999 },
  orbOne: {
    width: 260,
    height: 260,
    top: -90,
    right: -70,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  orbTwo: {
    width: 180,
    height: 180,
    top: 90,
    left: -80,
    backgroundColor: 'rgba(6,182,212,0.18)',
  },
});
