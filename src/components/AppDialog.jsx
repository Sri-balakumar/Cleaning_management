import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, BackHandler, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
