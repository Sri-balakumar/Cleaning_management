import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { fetchMatchProof, fetchRoundImages } from '../api/cleaning';
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
  // Compared, and the answer was that it could not be answered. Muted like
  // unknown, because it is no verdict on the room - but a band of its own,
  // because "Not compared" is untrue of a comparison that ran.
  unaligned: { key: 'matchUnaligned', color: colors.textMuted, bg: colors.surfaceAlt, border: colors.border },
};

/** Many2one fields arrive as `[id, "Display Name"]`. */
const referenceIdOf = (shot) =>
  Array.isArray(shot.reference_image_id) ? shot.reference_image_id[0] : shot.reference_image_id;

export function RoundPhotos({ baseUrl, recordingId, shots }) {
  const { t } = useT();
  const [viewing, setViewing] = useState(null);
  // Every picture for the round in one go. Each card used to fetch its own two,
  // so four views sent eight full-size images at once and the ones at the back
  // of the queue looked broken rather than merely slow.
  const [images, setImages] = useState({ shots: {}, originals: {} });

  // Joined into a string on purpose: the shots array is rebuilt by the screen
  // above on every render, so depending on it directly would re-fetch every
  // picture each time. The ids are what actually decide what to ask for.
  const referenceKey = shots.map(referenceIdOf).filter(Boolean).join(',');

  useEffect(() => {
    if (!recordingId) return undefined;
    let live = true;
    fetchRoundImages(
      baseUrl,
      recordingId,
      referenceKey ? referenceKey.split(',').map(Number) : [],
    )
      .then((loaded) => live && setImages(loaded))
      // Pictures that will not load cost the pictures, not the verdicts beside
      // them - which are the part actually worth reading.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [baseUrl, recordingId, referenceKey]);

  // Fetched on demand rather than with the round. It is looked at when a
  // number is doubted, which is rarely, and it is a bigger picture than
  // either photograph.
  const openProof = (shot) => {
    setViewing({ name: t.matchProofTitle, image: null, mime: "image/png" });
    fetchMatchProof(baseUrl, shot.id)
      .then((png) => png && setViewing({
        name: t.matchProofTitle, image: png, mime: "image/png",
      }))
      // A drawing that will not load costs the drawing, not the verdict it
      // was going to explain.
      .catch(() => setViewing(null));
  };

  return (
    <>
      {shots.map((shot, index) => (
        <ShotRow
          key={shot.id}
          shot={shot}
          image={images.shots[shot.id] || null}
          original={images.originals[referenceIdOf(shot)] || null}
          last={index === shots.length - 1}
          onOpen={setViewing}
          onProof={openProof}
        />
      ))}

      <ImageViewer
        visible={!!viewing}
        base64={viewing?.image}
        title={viewing?.name}
        mime={viewing?.mime}
        onClose={() => setViewing(null)}
      />
    </>
  );
}

/**
 * One view: the picture, the original, the verdict.
 *
 * Both pictures are handed down rather than fetched here. The row still draws
 * from the name and the score straight away and fills in when they arrive --
 * the difference is that they now arrive together, on one round trip for the
 * whole round, instead of two per card racing each other for a worker.
 */
function ShotRow({ shot, image, original, last, onOpen, onProof }) {
  const { t, rtlRow, rtlText } = useT();

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
        <Pane
          label={shot.from_video ? t.fromRecordingLabel : t.todayLabel}
          base64={image}
          name={shot.name}
          onOpen={onOpen}
        />
      </View>

      <View style={[styles.scoreRow, rtlRow]}>
        {/* Two different questions. Similar is how much of the same thing is
            in both pictures and can always be answered; Match is whether
            anything moved, and only means something once the two were lined
            up. So Match is shown when they were - or on a server with no
            feature matching, where the tile score is the only answer there
            is and withholding it would leave the card blank. */}
        {shot.same_view ? (
          <Text style={[styles.similar, rtlText]}>
            {`${t.similarLabel}: ${shot.similarity}%`}
          </Text>
        ) : null}

        {shot.same_view && shot.match_count ? (
          <Pressable
            onPress={() => onProof(shot)}
            hitSlop={8}
            accessibilityRole="button"
            style={styles.proofBtn}
          >
            <Ionicons name="search" size={12} color={colors.primary} />
            <Text style={styles.proofText}>
              {`${shot.match_count} ${t.matchingFeatures}`}
            </Text>
          </Pressable>
        ) : null}

        {shot.registered || (!shot.same_view && shot.matched_at) ? (
          <Text style={[styles.score, { color: band.color }]}>
            {`${t.matchLabelShort}: ${shot.match_score}%`}
          </Text>
        ) : null}
      </View>

      {/* Why the number is missing, or why it wants reading carefully. The
          same two sentences the web shows, for the same two states. */}
      {shot.poorly_framed ? (
        <Text style={[styles.note, styles.noteWarn, rtlText]}>{t.poorlyFramedNote}</Text>
      ) : shot.view_mismatch ? (
        <Text style={[styles.note, styles.noteWarn, rtlText]}>{t.notSameViewNote}</Text>
      ) : null}

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
  similar: { ...typography.caption, fontWeight: "700" },
  proofBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  proofText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  noteWarn: { color: colors.warning },
  score: { fontSize: 15, fontWeight: '700' },
  note: { ...typography.caption, lineHeight: 18 },
  noteError: { color: colors.danger },
});
