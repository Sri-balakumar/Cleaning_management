import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchReferenceImageData } from '../api/config';
import { ImageViewer } from './ImageViewer';
import { PhotoCapture } from './PhotoCapture';
import { PrimaryButton } from './PrimaryButton';
import { TextRow } from './SettingRows';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';

/**
 * The four originals: this is how each view of the room should look.
 *
 * The list deliberately shows no pictures. Four originals are megabytes, and
 * the only question a list answers is "is this view set up yet?" -- so the row
 * shows that, and the picture is fetched when somebody opens one.
 *
 * There is no add and no remove. The server keeps exactly one row per
 * direction and there is never a fifth; clearing the picture is what "we do not
 * check this view" means, and it leaves the row and its name intact for later.
 */
export function ShowroomViews({ baseUrl, views, disabled, onWrite }) {
  const { t, rtlRow, rtlText } = useT();
  const [editing, setEditing] = useState(null);

  const unset = views.filter((view) => !view.has_image).length;

  return (
    <>
      <Text style={[styles.blurb, rtlText]}>{t.showroomBlurb}</Text>

      {views.map((view, index) => (
        <Pressable
          key={view.id}
          onPress={() => setEditing(view)}
          disabled={disabled}
          accessibilityRole="button"
          style={[styles.row, rtlRow, index === views.length - 1 && styles.rowLast]}
        >
          <View style={[styles.badge, view.has_image ? styles.badgeSet : styles.badgeUnset]}>
            <Ionicons
              name={view.has_image ? 'image' : 'add'}
              size={18}
              color={view.has_image ? colors.primary : colors.textMuted}
            />
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowName, rtlText]}>{view.name}</Text>
            <Text style={[styles.rowState, rtlText]}>
              {view.has_image ? t.viewIsSet : t.viewNotSet}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Pressable>
      ))}

      {unset ? (
        <View style={styles.warn}>
          <Text style={[styles.warnText, rtlText]}>{t.showroomSomeUnset}</Text>
        </View>
      ) : null}

      <ViewEditor
        baseUrl={baseUrl}
        view={editing}
        disabled={disabled}
        onWrite={onWrite}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

/**
 * One view, full screen: its picture, its name and what to look for.
 *
 * The picture is loaded here rather than by the list, and only while this is
 * open. A freshly taken one is held in state and shown immediately, so the
 * manager sees what they just took without waiting for a round trip.
 */
function ViewEditor({ baseUrl, view, disabled, onWrite, onClose }) {
  const insets = useSafeAreaInsets();
  const { t, rtlRow, rtlText } = useT();

  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [image, setImage] = useState(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pickerDenied, setPickerDenied] = useState(false);
  const [viewing, setViewing] = useState(false);
  // Null until the manager takes or clears one: only then is the picture part
  // of what gets saved, so re-saving a name never rewrites megabytes.
  const [pendingImage, setPendingImage] = useState(null);

  const id = view?.id;
  const hasImage = view?.has_image;

  useEffect(() => {
    if (!view) return;
    setName(view.name || '');
    setInstructions(view.instructions || '');
    setPendingImage(null);
    setImage(null);
    if (!hasImage) return;
    let live = true;
    setLoadingImage(true);
    fetchReferenceImageData(baseUrl, id)
      .then((data) => {
        if (live) setImage(data);
      })
      // A picture that will not load is worth a placeholder, never an error
      // banner over a screen whose other fields are perfectly usable.
      .catch(() => {})
      .finally(() => {
        if (live) setLoadingImage(false);
      });
    return () => {
      live = false;
    };
  }, [baseUrl, hasImage, id, view]);

  const save = useCallback(() => {
    const values = { name, instructions };
    if (pendingImage !== null) values.image = pendingImage;
    onWrite(id, values);
    onClose();
  }, [id, instructions, name, onWrite, onClose, pendingImage]);

  const captured = useCallback((base64) => {
    setPendingImage(base64);
    setImage(base64);
    setCapturing(false);
  }, []);

  /**
   * Use a photograph the phone already has.
   *
   * Worth having beside the camera, not instead of it. The originals are often
   * taken once, on a good day, with the room properly set up - and whoever
   * finally sits down to configure the app is not necessarily standing in the
   * showroom at the time.
   *
   * base64 straight from the picker, so this lands in the same field the camera
   * fills. The server bounds the size on the way in, so a full-resolution
   * gallery photograph is no worse than a fresh one.
   */
  const choose = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPickerDenied(true);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      base64: true,
      allowsMultipleSelection: false,
    });
    if (result.canceled) return;
    const picked = result.assets?.[0]?.base64;
    if (!picked) return;
    setPendingImage(picked);
    setImage(picked);
  }, []);

  const clear = useCallback(() => {
    setPendingImage(false);
    setImage(null);
  }, []);

  const shown = pendingImage === false ? null : image;

  // Save stays faded until there is something to save. `pendingImage` is null
  // only while the picture is untouched, so taking, choosing and clearing one
  // all count - which is why it is that rather than a comparison against
  // `image`, whose value is the same after a clear as before a picture existed.
  const dirty =
    name !== (view?.name || '') ||
    instructions !== (view?.instructions || '') ||
    pendingImage !== null;

  return (
    <Modal visible={!!view} animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={[styles.header, rtlRow, { paddingTop: insets.top + spacing.md }]}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={[styles.headerTitle, rtlText]} numberOfLines={1}>
            {view?.name}
          </Text>
        </View>

        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xxxl }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Tappable once there is something to enlarge. `contain` rather
              than `cover` even here: what a crop hides is the arrangement near
              the walls, which is the part a round is measured on. */}
          <Pressable
            style={styles.preview}
            onPress={() => shown && setViewing(true)}
            disabled={!shown}
            accessibilityRole={shown ? 'button' : 'image'}
            accessibilityLabel={shown ? t.viewFullSize : undefined}
          >
            {loadingImage ? (
              <ActivityIndicator color={colors.primary} />
            ) : shown ? (
              <>
                <Image
                  source={{ uri: `data:image/jpeg;base64,${shown}` }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
                <View style={styles.expand}>
                  <Ionicons name="expand-outline" size={16} color={colors.white} />
                </View>
              </>
            ) : (
              <View style={styles.previewEmpty}>
                <Ionicons name="camera-outline" size={34} color={colors.textMuted} />
                <Text style={[styles.previewEmptyText, rtlText]}>{t.viewNotSet}</Text>
              </View>
            )}
          </Pressable>

          {/* Take and Choose share a row as the two ways of getting a picture;
              Clear sits under them, because it is the one that throws work
              away and should not be a neighbour of the button beside it. */}
          <View style={[styles.actions, rtlRow]}>
            <PrimaryButton
              label={shown ? t.retakePhoto : t.takePhoto}
              icon="camera-outline"
              onPress={() => setCapturing(true)}
              disabled={disabled}
              style={styles.action}
            />
            <PrimaryButton
              label={t.choosePhoto}
              icon="images-outline"
              variant="ghost"
              onPress={choose}
              disabled={disabled}
              style={styles.action}
            />
          </View>
          {pickerDenied ? <Text style={[styles.denied, rtlText]}>{t.photosPermissionDenied}</Text> : null}
          {shown ? (
            <PrimaryButton
              label={t.clearPhoto}
              variant="danger"
              onPress={clear}
              disabled={disabled}
            />
          ) : null}

          <View style={styles.card}>
            <TextRow label={t.viewName} hint={t.viewNameHint} value={name} onChange={setName} />
            <TextRow
              label={t.viewInstructions}
              hint={t.viewInstructionsHint}
              value={instructions}
              onChange={setInstructions}
              multiline
              last
            />
          </View>

          <PrimaryButton
            label={t.save}
            icon="save-outline"
            onPress={save}
            disabled={disabled || !dirty}
          />
        </ScrollView>

        <PhotoCapture
          visible={capturing}
          title={view?.name}
          hint={instructions || t.showroomCaptureHint}
          onCapture={captured}
          onClose={() => setCapturing(false)}
        />

        <ImageViewer
          visible={viewing}
          base64={shown}
          title={view?.name}
          onClose={() => setViewing(false)}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  blurb: {
    ...typography.caption,
    lineHeight: 18,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  badge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSet: { backgroundColor: colors.primarySoft },
  badgeUnset: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  rowText: { flex: 1 },
  rowName: { ...typography.body },
  rowState: { ...typography.caption },
  warn: {
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  warnText: { ...typography.caption, color: colors.warning, lineHeight: 18 },

  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTitle: { ...typography.title, flex: 1 },
  body: { padding: spacing.lg, gap: spacing.lg },
  preview: {
    height: 220,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  previewImage: { width: '100%', height: '100%' },
  expand: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    padding: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.overlay,
  },
  previewEmpty: { alignItems: 'center', gap: spacing.sm },
  previewEmptyText: { ...typography.caption },
  actions: { flexDirection: 'row', gap: spacing.md },
  action: { flex: 1 },
  denied: { ...typography.caption, color: colors.danger },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
  },
});
