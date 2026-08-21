import React from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuth } from '../src/auth/AuthContext';
import { GradientBackground, GradientOrbs } from '../src/components/GradientBackground';
import { useT } from '../src/i18n/LanguageProvider';
import { colors, radius, spacing } from '../src/theme';
import { log } from '../src/utils/log';
/**
 * Boot gate. Shows the branded splash while AuthProvider tries to restore a
 * session, then sends the user to the right stack.
 */
export default function Index() {
  const { status } = useAuth();
  const { t } = useT();
  if (status === 'restoring') {
    return (
      <GradientBackground>
        <GradientOrbs />
        <View style={styles.center}>
          {/* The same mark the login screen carries, and no product name.
              This carried a stale product name long after the app was
              renamed - a name in two places goes stale in one of them. */}
          <Image
            source={require('../assets/logo-369.png')}
            style={styles.logo}
            resizeMode="contain"
            accessibilityRole="image"
            accessibilityLabel="369 ai.Biz"
          />
          <Text style={styles.subtitle}>{t.restoringSession}</Text>
          <ActivityIndicator color={colors.white} style={styles.spinner} />
        </View>
      </GradientBackground>
    );
  }
  // The dashboard, which is the first tab and the whole point of opening the
  // app: today's rounds and whether one is due. Profile is somewhere you go on
  // purpose, not somewhere you land.
  const target = status === 'authenticated' ? '/rounds' : '/login';
  log('boot', `session ${status} - redirecting to ${target}`);
  return <Redirect href={target} />;
}
const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  // 467x368 source, held to that ratio so the wordmark never distorts.
  logo: { width: 140, height: 110, marginBottom: spacing.lg },
  subtitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onGradientMuted,
    marginTop: spacing.sm,
  },
  spinner: { marginTop: spacing.xxl },
});
