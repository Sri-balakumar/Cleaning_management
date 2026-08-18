import React, { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppError } from '../../src/api/errors';
import { useAuth } from '../../src/auth/AuthContext';
import { Avatar } from '../../src/components/Avatar';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { InfoCard, InfoRow } from '../../src/components/InfoRow';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { colors, radius, spacing, typography } from '../../src/theme';
import { displayUrl } from '../../src/utils/url';
/** The backend returns naive UTC datetimes as "YYYY-MM-DD HH:MM:SS". */
function formatServerDate(value) {
  if (!value) return undefined;
  const parsed = new Date(value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, connection, refreshProfile, signOut } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState(null);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshProfile();
    } catch (e) {
      setError(AppError.from(e).message);
    } finally {
      setRefreshing(false);
    }
  }, [refreshProfile]);
  const performSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut();
      router.replace('/login');
    } finally {
      setSigningOut(false);
    }
  }, [router, signOut]);
  const confirmSignOut = useCallback(() => {
    Alert.alert('Sign out', 'You will need to enter your credentials again to sign back in.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void performSignOut() },
    ]);
  }, [performSignOut]);
  if (!user) return null;
  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        <GradientBackground style={[styles.banner, { paddingTop: insets.top + spacing.xl }]}>
          <GradientOrbs />
          <Avatar name={user.name} base64={user.avatarBase64} size={96} ring />
          <Text style={styles.name} numberOfLines={1}>
            {user.name}
          </Text>
          {user.jobTitle ? <Text style={styles.role}>{user.jobTitle}</Text> : null}
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{user.isAdmin ? 'Administrator' : 'Internal user'}</Text>
          </View>
        </GradientBackground>

        <View style={styles.body}>
          {error ? (
            <View style={styles.bannerWrap}>
              <ErrorBanner message={error} />
            </View>
          ) : null}

          <InfoCard title="Account">
            <InfoRow icon="person-outline" label="Full name" value={user.name} />
            <InfoRow icon="at-outline" label="Username" value={user.login} />
            <InfoRow icon="mail-outline" label="Email" value={user.email} />
            <InfoRow icon="call-outline" label="Phone" value={user.phone} />
            <InfoRow icon="phone-portrait-outline" label="Mobile" value={user.mobile} />
            <InfoRow icon="briefcase-outline" label="Job position" value={user.jobTitle} last />
          </InfoCard>

          <InfoCard title="Workspace">
            <InfoRow icon="business-outline" label="Company" value={user.companyName} />
            <InfoRow icon="people-outline" label="Contact" value={user.partnerName} />
            <InfoRow icon="time-outline" label="Timezone" value={user.timezone} />
            <InfoRow icon="language-outline" label="Language" value={user.language} last />
          </InfoCard>

          <InfoCard title="Connection">
            <InfoRow
              icon="globe-outline"
              label="Server"
              value={connection ? displayUrl(connection.baseUrl) : undefined}
            />
            <InfoRow icon="server-outline" label="Database" value={connection?.db} />
            <InfoRow icon="finger-print-outline" label="User ID" value={String(user.uid)} />
            <InfoRow icon="cube-outline" label="Server version" value={connection?.serverVersion} />
            <InfoRow
              icon="log-in-outline"
              label="Last login"
              value={formatServerDate(user.lastLogin)}
              last
            />
          </InfoCard>

          <PrimaryButton
            label="Sign out"
            icon="log-out-outline"
            variant="danger"
            loading={signingOut}
            onPress={confirmSignOut}
          />

          <Text style={styles.footnote}>Pull down to refresh these details.</Text>
        </View>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: spacing.xxxl },
  banner: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  name: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.white,
    marginTop: spacing.lg,
    letterSpacing: -0.3,
  },
  role: { fontSize: 13, fontWeight: '500', color: colors.onGradientMuted, marginTop: spacing.xs },
  badge: {
    marginTop: spacing.lg,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.lg,
  },
  badgeText: { fontSize: 12, fontWeight: '700', color: colors.white, letterSpacing: 0.3 },
  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.xxl },
  bannerWrap: { marginBottom: spacing.xl },
  footnote: { ...typography.caption, textAlign: 'center', marginTop: spacing.xl },
});
