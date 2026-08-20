import React from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../i18n/LanguageProvider';
import { colors, spacing, typography } from '../theme';

/**
 * One picture, as large as the screen allows.
 *
 * `contain` rather than `cover`, which is the whole point of opening it: the
 * thumbnail crops, and what gets cropped off an original is the arrangement
 * near the walls - the part a round is actually measured on.
 *
 * Takes base64 rather than a url. That is what the app already holds for a
 * server-side picture, for the same reason Avatar does: the session cookie is
 * attached by hand on native and is a forbidden header on web, so an <Image>
 * pointed at /web/image would be unauthenticated on one platform or the other.
 *
 * `mime` because not everything shown here is a photograph: the drawing of
 * matched features is a PNG. Most platforms sniff the bytes and would cope
 * with being told the wrong type, which is exactly why getting it wrong is
 * the kind of bug that surfaces on one device a year later.
 *
 * Tap anywhere to close, as well as the button. A picture filling the screen
 * with one small control in the corner invites a tap somewhere in the middle.
 */
export function ImageViewer({ visible, base64, title, onClose, mime = 'image/jpeg' }) {
  const insets = useSafeAreaInsets();
  const { t, rtlText } = useT();

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose}>
      <Pressable style={styles.screen} onPress={onClose} accessibilityRole="button">
        {base64 ? (
          <Image
            source={{ uri: `data:${mime};base64,${base64}` }}
            style={styles.image}
            resizeMode="contain"
          />
        ) : null}

        <View style={[styles.bar, { paddingTop: insets.top + spacing.md }]} pointerEvents="box-none">
          <Text style={[styles.title, rtlText]} numberOfLines={1}>
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t.close}
          >
            <Ionicons name="close" size={26} color={colors.white} />
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  image: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: { ...typography.heading, color: colors.white, flex: 1 },
});
