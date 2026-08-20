import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppError } from '../../src/api/errors';
import { useAuth } from '../../src/auth/AuthContext';
import { Avatar } from '../../src/components/Avatar';
import { useDialog } from '../../src/components/AppDialog';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { InfoCard, InfoRow } from '../../src/components/InfoRow';
import { PoweredBy } from '../../src/components/PoweredBy';
import { LanguageToggle } from '../../src/components/LanguageToggle';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';
import { log } from '../../src/utils/log';
import { displayUrl } from '../../src/utils/url';
export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, connection, refreshProfile, signOut } = useAuth();
  const { confirm } = useDialog();
  const { t, rtlText } = useT();
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState(null);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshProfile();
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setRefreshing(false);
    }
  }, [refreshProfile, t]);
  const performSignOut = useCallback(
    async (options) => {
      setSigningOut(true);
      try {
        await signOut(options);
        router.replace('/login');
      } finally {
        setSigningOut(false);
      }
    },
    [router, signOut],
  );
  const confirmSignOut = useCallback(() => {
    confirm({
      title: t.logOut,
      message: t.logOutMessage,
      icon: 'log-out-outline',
      tone: 'danger',
      actions: [
        { label: t.logOut, style: 'destructive', onPress: () => void performSignOut() },
        { label: t.cancel, style: 'cancel' },
      ],
    });
  }, [confirm, performSignOut, t]);
  useEffect(() => {
    log('screen', 'profile mounted', { hasUser: !!user });
  }, [user]);

  // A null user blanks this screen entirely - worth seeing in the log.
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
          {user.jobTitle ? <Text style={[styles.role, rtlText]}>{user.jobTitle}</Text> : null}
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {user.isAdmin ? t.administrator : t.internalUser}
            </Text>
          </View>
          {/* Sits with identity rather than buried in a settings list -- it is
              the one preference this app has. */}
          <View style={styles.langWrap}>
            <LanguageToggle onGradient />
          </View>
        </GradientBackground>

        <View style={styles.body}>
          {error ? (
            <View style={styles.bannerWrap}>
              <ErrorBanner message={error} />
            </View>
          ) : null}

          {/* Name and job title are already in the header above, so they are
              not repeated. Server is the one row the reference app has no need
              for: its backend is fixed, this one is chosen at login. */}
          <InfoCard title={t.accountDetails}>
            <InfoRow icon="finger-print-outline" label={t.userId} value={String(user.uid)} />
            <InfoRow icon="at-outline" label={t.username} value={user.login} />
            <InfoRow icon="server-outline" label={t.database} value={connection?.db} />
            <InfoRow icon="people-outline" label={t.contact} value={user.partnerName} />
            <InfoRow
              icon="globe-outline"
              label={t.server}
              value={connection ? displayUrl(connection.baseUrl) : undefined}
              last
            />
          </InfoCard>

          {/* Open to everyone. Which documents are on the other side of this is
              the server's decision, made from who signed in -- repeating any of
              it here would only give the two rules a chance to disagree. */}
          <PrimaryButton
            label={t.help}
            icon="help-circle-outline"
            onPress={() => router.push('/help')}
            style={styles.helpBtn}
          />

          <PrimaryButton
            label={t.logOut}
            icon="log-out-outline"
            variant="danger"
            loading={signingOut}
            onPress={confirmSignOut}
          />

          <PoweredBy />
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
  langWrap: { marginTop: spacing.lg },
  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.xxl },
  bannerWrap: { marginBottom: spacing.xl },
  // The two buttons would otherwise sit flush against each other; the cards
  // above carry their own bottom margin, so only this pair needs the gap.
  helpBtn: { marginBottom: spacing.md },
});
