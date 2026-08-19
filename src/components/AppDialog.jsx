import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, BackHandler, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppError } from '../api/errors';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';
import { PrimaryButton } from './PrimaryButton';

/**
 * Replaces the operating system's Alert.
 *
 * The stock alert is drawn by the OS, so it looks like Android on Android and
 * iOS on iOS and like this app on neither. Everything the user is asked here
 * now uses the same card, type and buttons as the rest of the app.
 *
 * Imperative on purpose -- confirmations happen inside callbacks, not render,
 * so a `<Dialog visible={...}>` per screen would mean a piece of state and a
 * handler at every call site.
 *
 *   const { confirm } = useDialog();
 *   confirm({
 *     title: 'Sign out',
 *     message: 'You will need your password again.',
 *     icon: 'log-out-outline',
 *     actions: [
 *       { label: 'Sign out', onPress: doIt },
 *       { label: 'Cancel', style: 'cancel' },
 *     ],
 *   });
 */
const DialogContext = createContext(null);

/** Action `style` -> button variant. */
const VARIANTS = { cancel: 'ghost', destructive: 'danger', default: 'gradient' };

export function DialogProvider({ children }) {
  const { t } = useT();
  const [request, setRequest] = useState(null);
  const [visible, setVisible] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  const confirm = useCallback((options) => {
    setRequest(options);
    setVisible(true);
  }, []);

  const close = useCallback(() => {
    Animated.timing(anim, { toValue: 0, duration: 140, useNativeDriver: true }).start(() => {
      setVisible(false);
      setRequest(null);
    });
  }, [anim]);

  useEffect(() => {
    if (visible) {
      Animated.spring(anim, {
        toValue: 1,
        useNativeDriver: true,
        speed: 18,
        bounciness: 6,
      }).start();
    }
  }, [visible, anim]);

  // Android's back button should dismiss, exactly as it does for a real alert.
  useEffect(() => {
    if (!visible) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (request?.dismissable !== false) close();
      return true;
    });
    return () => sub.remove();
  }, [visible, request, close]);

  const run = useCallback(
    (action) => {
      close();
      // Let the dismissal animation finish before the caller navigates or
      // opens something else on top.
      if (action.onPress) setTimeout(action.onPress, 160);
    },
    [close],
  );

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <DialogContext.Provider value={value}>
      {children}
      <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={close}>
        <Animated.View style={[styles.backdrop, { opacity: anim }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => request?.dismissable !== false && close()}
            accessibilityLabel={t.dismiss}
          />
          <Animated.View
            style={[
              styles.card,
              {
                opacity: anim,
                transform: [
                  { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
                ],
              },
            ]}
          >
            {request?.icon ? (
              <View style={[styles.iconRing, request.tone === 'danger' && styles.iconRingDanger]}>
                <Ionicons
                  name={request.icon}
                  size={24}
                  color={request.tone === 'danger' ? colors.danger : colors.primary}
                />
              </View>
            ) : null}

            {/* Centred in both languages -- these are short and direction-neutral. */}
            {request?.title ? <Text style={styles.title}>{request.title}</Text> : null}
            {request?.message ? <Text style={styles.message}>{request.message}</Text> : null}

            <View style={styles.actions}>
              {(request?.actions ?? [{ label: t.ok }]).map((action) => (
                <PrimaryButton
                  key={action.label}
                  label={action.label}
                  icon={action.icon}
                  variant={VARIANTS[action.style] ?? VARIANTS.default}
                  onPress={() => run(action)}
                />
              ))}
            </View>
          </Animated.View>
        </Animated.View>
      </Modal>
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used inside <DialogProvider>');
  return ctx;
}

/**
 * A server that never answered gets a dialog, not a line of text.
 *
 * "The server took too long to respond" on a banner is easy to miss and offers
 * nothing to do about it, when the one thing anybody wants at that point is to
 * try again. Only for `timeout`: the other kinds either explain themselves
 * where they happen (a permission refusal) or need a different answer entirely
 * (a wrong password), and interrupting for those would just be noise.
 *
 * Raised once per outage rather than once per attempt. The dashboard asks the
 * server every 15 to 60 seconds, so a server that is down would otherwise put
 * this up again and again, over whatever the person had moved on to. It arms
 * itself again on the first call that gets through - and on Try again, so that
 * a retry which also times out still says so rather than failing silently.
 *
 * Takes the error itself, not a translated string: only the AppError knows
 * whether this was a timeout or something else entirely.
 */
export function useTimeoutDialog(error, onRetry) {
  const { confirm } = useDialog();
  const { t } = useT();
  const armed = useRef(true);
  // In a ref so a caller passing a fresh closure each render does not re-run
  // the effect and raise the dialog a second time.
  const retry = useRef(onRetry);
  retry.current = onRetry;

  useEffect(() => {
    if (!error) {
      armed.current = true;
      return;
    }
    if (!armed.current || AppError.from(error).kind !== 'timeout') return;
    armed.current = false;
    confirm({
      title: t.serverNotResponding,
      message: t.errors.timeout,
      icon: 'cloud-offline-outline',
      actions: [
        {
          label: t.tryAgain,
          onPress: () => {
            armed.current = true;
            retry.current?.();
          },
        },
        { label: t.cancel, style: 'cancel' },
      ],
    });
  }, [error, confirm, t]);
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    shadowColor: '#0F172A',
    shadowOpacity: 0.25,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
  iconRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    marginBottom: spacing.lg,
  },
  iconRingDanger: { backgroundColor: colors.dangerBg },
  title: { ...typography.title, textAlign: 'center' },
  message: {
    ...typography.caption,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: spacing.sm,
  },
  actions: { alignSelf: 'stretch', gap: spacing.md, marginTop: spacing.xxl },
});
