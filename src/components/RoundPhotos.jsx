import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { fetchShotImage } from '../api/cleaning';
import { fetchReferenceImageData } from '../api/config';
import { ImageViewer } from './ImageViewer';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';

/**
 * How a round's photographs came out: each one beside the original it was
 * measured against, and the verdict on the pair.
 *
 * Side by side because the comparison IS the point. A photograph on its own
 * says nothing about whether the room was right; the two together are the
 * whole check, and the same card in the Odoo backend reads the same way.
 *
 * The verdict wording is translated here rather than read off the server. A
 * fields_get would answer in the language of the Odoo account rather than the
 * one chosen in the app, which is the same reason the recordings list carries
 * its own labels for quality and AI status.
 */
const BANDS = {
  ok: { key: 'matchOk', color: colors.success, bg: colors.successBg, border: colors.successBorder },
  warn: { key: 'matchWarn', color: colors.warning, bg: colors.warningBg, border: colors.warningBorder },
  alert: { key: 'matchAlert', color: colors.danger, bg: colors.dangerBg, border: colors.dangerBorder },
  unknown: { key: 'matchUnknown', color: colors.textMuted, bg: colors.surfaceAlt, border: colors.border },
};

export function RoundPhotos({ baseUrl, shots }) {
  const [viewing, setViewing] = useState(null);

  return (
    <>
      {shots.map((shot, index) => (
        <ShotRow
          key={shot.id}
          baseUrl={baseUrl}
          shot={shot}
          last={index === shots.length - 1}
          onOpen={setViewing}
        />
      ))}

      <ImageViewer
        visible={!!viewing}
        base64={viewing?.image}
        title={viewing?.name}
        onClose={() => setViewing(null)}
      />
    </>
  );
}

function ShotRow({ baseUrl, shot, last, onOpen }) {
  const { t, rtlRow, rtlText } = useT();
  const [image, setImage] = useState(null);
  const [original, setOriginal] = useState(null);

  // Both pictures after the card is on screen, not before it. The row draws
  // from the name and the score straight away and fills in as they arrive.
  const referenceId = Array.isArray(shot.reference_image_id)
    ? shot.reference_image_id[0]
    : shot.reference_image_id;

  useEffect(() => {
    let live = true;
    fetchShotImage(baseUrl, shot.id)
      .then((data) => live && setImage(data))
      // A picture that will not load costs the picture, not the verdict beside
      // it - which is the part actually worth reading.
      .catch(() => {})
      .finally(() => {});
    return () => {
      live = false;
    };
  }, [baseUrl, shot.id]);

  useEffect(() => {
    if (!referenceId) return undefined;
    let live = true;
    fetchReferenceImageData(baseUrl, referenceId)
      .then((data) => live && setOriginal(data))
      .catch(() => {})
      .finally(() => {});
    return () => {
      live = false;
    };
  }, [baseUrl, referenceId]);

  const band = BANDS[shot.match_level] || BANDS.unknown;

  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <View style={[styles.head, rtlRow]}>
        <Text style={[styles.name, rtlText]} numberOfLines={1}>
          {shot.name}
        </Text>
        <View style={[styles.badge, { backgroundColor: band.bg, borderColor: band.border }]}>
          <Text style={[styles.badgeText, { color: band.color }]}>{t[band.key]}</Text>
        </View>
      </View>

      <View style={[styles.pair, rtlRow]}>
        <Pane
          label={t.theOriginal}
          base64={original}
          name={shot.name}
          onOpen={onOpen}
        />
        <Pane label={t.todayLabel} base64={image} name={shot.name} onOpen={onOpen} />
      </View>

      <View style={[styles.scoreRow, rtlRow]}>
        {/* Only where there is a real one. An unscored photograph showing "0"
            would read as the worst possible result rather than as no result. */}
        {shot.matched_at ? (
          <Text style={[styles.score, { color: band.color }]}>
            {`${t.matchLabelShort} ${shot.match_score}%`}
          </Text>
        ) : null}
      </View>

      {/* What changed, in words - the one thing no measurement produces. Or why
          it could not be compared, which matters just as much. */}
      {shot.ai_changes ? (
        <Text style={[styles.note, rtlText]}>{shot.ai_changes}</Text>
      ) : shot.match_error ? (
        <Text style={[styles.note, styles.noteError, rtlText]}>{shot.match_error}</Text>
      ) : null}
    </View>
  );
}

function Pane({ label, base64, name, onOpen }) {
  return (
    <View style={styles.pane}>
      <Text style={styles.paneLabel}>{label}</Text>
      <Pressable
        style={styles.paneBody}
        onPress={() => base64 && onOpen({ image: base64, name })}
        disabled={!base64}
        accessibilityRole={base64 ? 'button' : 'image'}
      >
        {base64 ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${base64}` }}
            style={styles.paneImage}
            resizeMode="cover"
          />
        ) : (
          <ActivityIndicator color={colors.primary} size="small" />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.body, flex: 1 },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },

  pair: { flexDirection: 'row', gap: spacing.sm },
  pane: { flex: 1, gap: 2 },
  paneLabel: { ...typography.caption, fontSize: 11 },
  paneBody: {
    height: 130,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paneImage: { width: '100%', height: '100%' },

  scoreRow: { flexDirection: 'row', alignItems: 'center' },
  score: { fontSize: 15, fontWeight: '700' },
  note: { ...typography.caption, lineHeight: 18 },
  noteError: { color: colors.danger },
});
