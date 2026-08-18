import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/auth/AuthContext';
import { GradientBackground, GradientOrbs } from '../src/components/GradientBackground';
import { colors, radius, spacing } from '../src/theme';
/**
 * Boot gate. Shows the branded splash while AuthProvider tries to restore a
 * session, then sends the user to the right stack.
 */
export default function Index() {
  const { status } = useAuth();
  if (status === 'restoring') {
    return (
      <GradientBackground>
        <GradientOrbs />
        <View style={styles.center}>
          <View style={styles.logo}>
            <Ionicons name="sparkles" size={34} color={colors.white} />
          </View>
          <Text style={styles.title}>CleanPro</Text>
          <Text style={styles.subtitle}>Restoring your session…</Text>
          <ActivityIndicator color={colors.white} style={styles.spinner} />
        </View>
      </GradientBackground>
    );
  }
  return <Redirect href={status === 'authenticated' ? '/rounds' : '/login'} />;
}
const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  logo: {
    width: 78,
    height: 78,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glassStrong,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    marginBottom: spacing.xl,
  },
  title: { fontSize: 30, fontWeight: '700', color: colors.white, letterSpacing: -0.5 },
  subtitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onGradientMuted,
    marginTop: spacing.sm,
  },
  spinner: { marginTop: spacing.xxl },
});
