import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppError } from '../../src/api/errors';
import { probeServer } from '../../src/api/backend';
import { useAuth } from '../../src/auth/AuthContext';
import { loadRememberedServer } from '../../src/auth/storage';
import { AppTextField } from '../../src/components/AppTextField';
import { DatabasePicker, SelectField } from '../../src/components/DatabasePicker';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { colors, radius, spacing, typography } from '../../src/theme';
import { displayUrl, looksProbeworthy } from '../../src/utils/url';
import { useKeyboardHeight } from '../../src/utils/useKeyboardHeight';
const PROBE_DEBOUNCE_MS = 700;
export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const keyboardHeight = useKeyboardHeight();
  const [urlInput, setUrlInput] = useState('');
  const [probeState, setProbeState] = useState('idle');
  const [baseUrl, setBaseUrl] = useState(null);
  const [databases, setDatabases] = useState([]);
  const [listingDisabled, setListingDisabled] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [db, setDb] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [urlError, setUrlError] = useState(null);
  const [urlErrorDetail, setUrlErrorDetail] = useState(null);
  const [formError, setFormError] = useState(null);
  const [credentialError, setCredentialError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef(null);
  const scrollRef = useRef(null);
  /** Y offset of the credentials block, so focus can scroll it clear. */
  const credentialsY = useRef(0);
  /** Guards against a slow earlier probe overwriting a newer one's result. */
  const probeSeq = useRef(0);
  const reveal = useRef(new Animated.Value(0)).current;
  const resetServerState = useCallback(() => {
    probeSeq.current += 1; // invalidate any in-flight probe
    setProbeState('idle');
    setBaseUrl(null);
    setDatabases([]);
    setListingDisabled(false);
    setUrlError(null);
    setUrlErrorDetail(null);
  }, []);
  const runProbe = useCallback(async (raw) => {
    const seq = ++probeSeq.current;
    setProbeState('checking');
    setUrlError(null);
    setUrlErrorDetail(null);
    setFormError(null);
    try {
      const result = await probeServer(raw);
      if (seq !== probeSeq.current) return;
      setBaseUrl(result.baseUrl);
      setDatabases(result.databases);
      setListingDisabled(result.listingDisabled);
      setProbeState('ok');
      // One database is the common case -- pick it so there is nothing to tap.
      setDb((current) => {
        if (result.databases.length === 1) return result.databases[0];
        if (result.databases.length > 1) {
          return result.databases.includes(current) ? current : '';
        }
        return current; // listing disabled: keep whatever was typed manually
      });
    } catch (error) {
      if (seq !== probeSeq.current) return;
      const err = AppError.from(error);
      setProbeState('error');
      setBaseUrl(null);
      setDatabases([]);
      setListingDisabled(false);
      setUrlError(err.message);
      setUrlErrorDetail(err.detail ?? null);
    }
  }, []);
  // Restore the last server used, so signing back in only needs a password.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const remembered = await loadRememberedServer();
      if (cancelled || !remembered) return;
      setUrlInput(remembered.baseUrl);
      if (remembered.db) setDb(remembered.db);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // Auto-fetch databases as soon as the address looks complete.
  useEffect(() => {
    if (!looksProbeworthy(urlInput)) {
      resetServerState();
      return;
    }
    const timer = setTimeout(() => void runProbe(urlInput), PROBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [urlInput, runProbe, resetServerState]);
  useEffect(() => {
    Animated.timing(reveal, {
      toValue: probeState === 'ok' ? 1 : 0,
      duration: 280,
      useNativeDriver: true,
    }).start();
  }, [probeState, reveal]);
  /** Lift the credentials block above the keyboard when a field takes focus. */
  const scrollToCredentials = useCallback(() => {
    // Wait for the keyboard height to land before scrolling to the target.
    setTimeout(
      () =>
        scrollRef.current?.scrollTo({
          y: Math.max(0, credentialsY.current - spacing.xl),
          animated: true,
        }),
      Platform.OS === 'ios' ? 60 : 140,
    );
  }, []);
  const handleSubmit = useCallback(async () => {
    setFormError(null);
    setCredentialError(null);
    if (!baseUrl) {
      setFormError('Connect to a server before signing in.');
      return;
    }
    if (!db.trim()) {
      setFormError('Choose or enter a database.');
      return;
    }
    if (!login.trim() || !password) {
      setCredentialError('Enter both your username and password.');
      return;
    }
    setSubmitting(true);
    try {
      await signIn({ baseUrl, db: db.trim(), login: login.trim(), password });
      router.replace('/rounds');
    } catch (error) {
      const err = AppError.from(error);
      if (err.kind === 'invalid_credentials') setCredentialError(err.message);
      else setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }, [baseUrl, db, login, password, router, signIn]);
  const urlStatus = probeState === 'checking' ? 'checking' : probeState === 'ok' ? 'valid' : 'idle';
  const credentialsReady = probeState === 'ok';
  return (
    <GradientBackground>
      <GradientOrbs />
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[
            styles.scroll,
            {
              paddingTop: insets.top + spacing.xxl,
              // Edge-to-edge means the window no longer shrinks for the
              // keyboard, so the scroll content has to make the room itself.
              paddingBottom: spacing.xxxl + keyboardHeight,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={styles.logo}>
              <Ionicons name="sparkles" size={28} color={colors.white} />
            </View>
            <Text style={styles.brand}>CleanPro</Text>
            <Text style={styles.tagline}>Sign in to your workspace</Text>
          </View>

          <View style={styles.card}>
            <AppTextField
              label="Server address"
              icon="globe-outline"
              placeholder="erp.mycompany.com"
              value={urlInput}
              onChangeText={setUrlInput}
              onBlur={() => {
                if (looksProbeworthy(urlInput) && probeState === 'idle') void runProbe(urlInput);
              }}
              status={urlStatus}
              error={urlError}
              detail={urlErrorDetail}
              hint={
                probeState === 'ok' && baseUrl
                  ? `Connected to ${displayUrl(baseUrl)}`
                  : 'Address or IP, with a port if needed. On the Android emulator use 10.0.2.2 rather than localhost.'
              }
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
              editable={!submitting}
            />

            {probeState === 'ok' && !listingDisabled ? (
              <SelectField
                label="Database"
                value={db || null}
                placeholder={databases.length ? 'Choose a database' : 'No databases found'}
                onPress={() => setPickerOpen(true)}
                disabled={submitting || databases.length <= 1}
                hint={
                  databases.length === 1
                    ? 'This server hosts a single database, selected automatically.'
                    : `${databases.length} databases available on this server.`
                }
              />
            ) : null}

            {probeState === 'ok' && listingDisabled ? (
              <AppTextField
                label="Database"
                icon="server-outline"
                placeholder="Database name"
                value={db}
                onChangeText={setDb}
                hint="This server does not publish its database list. Enter the database name manually."
                autoCapitalize="none"
                autoCorrect={false}
                editable={!submitting}
              />
            ) : null}

            {credentialsReady ? (
              <Animated.View
                onLayout={(event) => {
                  credentialsY.current = event.nativeEvent.layout.y;
                }}
                style={{
                  opacity: reveal,
                  transform: [
                    {
                      translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }),
                    },
                  ],
                }}
              >
                <View style={styles.divider} />

                <AppTextField
                  label="Username"
                  icon="person-outline"
                  placeholder="you@company.com"
                  value={login}
                  onChangeText={setLogin}
                  onFocus={scrollToCredentials}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                  editable={!submitting}
                />

                <AppTextField
                  ref={passwordRef}
                  label="Password"
                  icon="lock-closed-outline"
                  placeholder="Your password"
                  value={password}
                  onChangeText={setPassword}
                  onFocus={scrollToCredentials}
                  secureToggle
                  error={credentialError}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={() => void handleSubmit()}
                  editable={!submitting}
                />
              </Animated.View>
            ) : null}

            <ErrorBanner message={formError} />

            <PrimaryButton
              label={credentialsReady ? 'Sign in' : 'Connect to server'}
              icon={credentialsReady ? 'arrow-forward' : undefined}
              onPress={() => (credentialsReady ? void handleSubmit() : void runProbe(urlInput))}
              loading={submitting || probeState === 'checking'}
              disabled={!looksProbeworthy(urlInput)}
              style={styles.submit}
            />

            {probeState === 'error' ? (
              <Pressable onPress={() => void runProbe(urlInput)} style={styles.retry} hitSlop={8}>
                <Ionicons name="refresh" size={15} color={colors.primary} />
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            ) : null}
          </View>

          <Text style={styles.footnote}>
            Your credentials are sent directly to your server and stored only on this device.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <DatabasePicker
        visible={pickerOpen}
        databases={databases}
        selected={db || null}
        onSelect={(value) => {
          setDb(value);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </GradientBackground>
  );
}
const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: spacing.xl },
  header: { alignItems: 'center', marginBottom: spacing.xxl },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glassStrong,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    marginBottom: spacing.lg,
  },
  brand: { fontSize: 28, fontWeight: '700', color: colors.white, letterSpacing: -0.5 },
  tagline: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onGradientMuted,
    marginTop: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    shadowColor: '#0F172A',
    shadowOpacity: 0.18,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  divider: { height: 1, backgroundColor: colors.border, marginBottom: spacing.xl },
  submit: { marginTop: spacing.sm },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  retryText: { ...typography.label, color: colors.primary },
  footnote: {
    ...typography.caption,
    color: colors.onGradientMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    lineHeight: 17,
  },
});
