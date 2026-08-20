import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from './PrimaryButton';
import { useT } from '../i18n/LanguageProvider';
import { useNavigationBarStyle } from '../utils/useNavigationBarStyle';
import { colors, radius, spacing, typography } from '../theme';

/**
 * Take one photograph and hand it back as base64.
 *
 * Its own component rather than part of the settings screen, because the round
 * itself will want exactly this next: stand in one spot, look one way, take one
 * picture. The only difference there is which view is being asked for, which is
 * what `title` and `hint` carry.
 *
 * base64 rather than the file uri, because every caller sends the picture to
 * the server as a field on a record rather than as a file upload. Reading the
 * uri back off disk afterwards would be a second step that can fail on its own.
 */
export function PhotoCapture({ visible, title, hint, onCapture, onClose }) {
  const insets = useSafeAreaInsets();
  // Black and full-screen, but only while it is open. See the hook.
  useNavigationBarStyle('light', visible);
  const { t, rtlText } = useT();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  // The camera reports when it is actually ready and the docs are explicit that
  // takePictureAsync must wait for it. Firing at a preview that has not settled
  // returns a black frame on Android, which would become somebody's original.
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const capture = useCallback(async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({
        quality: 0.7,
        base64: true,
        // skipProcessing is deliberately NOT set. It skips the orientation
        // correction, and the server compares an upright thumbnail - a sideways
        // original would measure every future round against a rotated room.
      });
      if (photo?.base64) onCapture(photo.base64);
    } finally {
      setBusy(false);
    }
  }, [busy, onCapture, ready]);

  // Asked for at the moment the camera is opened rather than on the way into
  // the screen: somebody only editing a name should never see a camera prompt.
  const body = () => {
    if (!permission) {
      return <ActivityIndicator color={colors.white} />;
    }
    if (!permission.granted) {
      return (
        <View style={styles.notice}>
          <Ionicons name="camera-outline" size={40} color={colors.white} />
          <Text style={[styles.noticeText, rtlText]}>{t.cameraPhotoBody}</Text>
          <PrimaryButton label={t.allowCamera} onPress={requestPermission} />
        </View>
      );
    }
    return (
      <>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing="back"
          mode="picture"
          onCameraReady={() => setReady(true)}
        />
        <View style={[styles.controls, { paddingBottom: insets.bottom + spacing.xl }]}>
          {hint ? <Text style={[styles.hint, rtlText]}>{hint}</Text> : null}
          <Pressable
            onPress={capture}
            disabled={!ready || busy}
            accessibilityRole="button"
            accessibilityLabel={t.takePhoto}
            style={[styles.shutter, (!ready || busy) && styles.shutterOff]}
          >
            {busy ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <View style={styles.shutterCore} />
            )}
          </Pressable>
        </View>
      </>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Ionicons name="close" size={24} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {body()}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: { ...typography.heading, color: colors.white, flex: 1 },
  camera: { flex: 1 },
  controls: { alignItems: 'center', gap: spacing.lg, paddingTop: spacing.xl },
  hint: {
    ...typography.body,
    color: colors.white,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: radius.pill,
    borderWidth: 4,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterOff: { opacity: 0.4 },
  shutterCore: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  notice: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
  noticeText: { ...typography.body, color: colors.white, textAlign: 'center' },
});
