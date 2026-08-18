import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import { fetchRecording, videoHeaders, videoUrl } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { InfoCard, InfoRow } from '../../src/components/InfoRow';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing } from '../../src/theme';

/** The backend hands back naive UTC: "YYYY-MM-DD HH:MM:SS". */
function formatMoment(value) {
  if (!value) return undefined;
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDay(isoDate) {
  const [y, m, d] = (isoDate || '').split('-').map(Number);
  if (!y) return isoDate || '';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Odoo returns `false` for empty values, so normalise before display. */
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const relationName = (v) => (Array.isArray(v) ? v[1] : undefined);

const QUALITY_KEYS = { low: 'qualityLow', medium: 'qualityMedium', high: 'qualityHigh' };
const AI_KEYS = { not_run: 'aiNotRun', done: 'aiDone', failed: 'aiFailed' };
export default function RecordingRoute() {
  return (
    <RequireAuth>
      <RecordingScreen />
    </RequireAuth>
  );
}

function RecordingScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const row = await fetchRecording(connection.baseUrl, id);
        if (cancelled) return;
        if (!row) throw new AppError('server', t.recordingNotFound);
        setRecord(row);
      } catch (e) {
        if (!cancelled) setError(translateError(t, AppError.from(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, id, t]);

  // The video route is permission-checked, so the session cookie has to travel
  // with the request the same way it does on every other call.
  const source = useMemo(
    () => ({ uri: videoUrl(connection.baseUrl, id), headers: videoHeaders() }),
    [connection, id],
  );

  const player = useVideoPlayer(source, (instance) => {
    instance.loop = false;
  });

  // Fetching the record and playing the file fail independently: the row can
  // read fine while the video itself is gone or unreadable.
  const { status: playbackStatus, error: playbackError } = useEvent(player, 'statusChange', {
    status: player.status,
  });

  const aiKey = AI_KEYS[record?.ai_status];
  const canManage = Boolean(record?.can_manage);

  const close = useCallback(() => router.back(), [router]);

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" style={styles.back}>
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={[styles.title, rtlText]} numberOfLines={1}>
              {relationName(record?.slot_id) ?? t.round}
            </Text>
            <Text style={[styles.subtitle, rtlText]} numberOfLines={1}>
              {[formatDay(record?.slot_date), relationName(record?.user_id)]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          {aiKey ? (
            <View style={[styles.pill, record.ai_status === 'done' && styles.pillDone]}>
              <Text style={styles.pillText}>{t[aiKey]}</Text>
            </View>
          ) : null}
        </View>
      </GradientBackground>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: spacing.xxxl + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        {loading ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
        {error ? <ErrorBanner message={error} /> : null}

        {record ? (
          <>
            <View style={styles.videoFrame}>
              <VideoView
                style={styles.video}
                player={player}
                allowsFullscreen
                allowsPictureInPicture
                contentFit="contain"
              />
              {playbackStatus === 'error' ? (
                <View style={styles.videoError}>
                  <Ionicons name="alert-circle-outline" size={30} color={colors.white} />
                  <Text style={styles.videoErrorTitle}>{t.couldNotPlay}</Text>
                  <Text style={styles.videoErrorText}>
                    {playbackError?.message || t.couldNotPlayBody}
                  </Text>
                </View>
              ) : null}
            </View>

            <InfoCard title={t.sectionRecording}>
              <InfoRow
                icon="person-outline"
                label={t.recordedBy}
                value={relationName(record.user_id)}
              />
              <InfoRow
                icon="play-outline"
                label={t.startedAt}
                value={formatMoment(record.started_at)}
              />
              <InfoRow icon="stop-outline" label={t.endedAt} value={formatMoment(record.ended_at)} />
              <InfoRow
                icon="timer-outline"
                label={t.actualDuration}
                value={`${record.duration_seconds ?? 0}${t.unitSecond}`}
              />
              <InfoRow
                icon="options-outline"
                label={t.configuredDuration}
                value={`${record.configured_duration_seconds ?? 0}${t.unitSecond}`}
              />
              <InfoRow
                icon="cut-outline"
                label={t.cutShortLabel}
                value={record.truncated ? t.yes : t.no}
                last
              />
            </InfoCard>

            <InfoCard title={t.sectionFile}>
              <InfoRow
                icon="document-outline"
                label={t.fileName}
                value={text(record.video_filename)}
              />
              <InfoRow
                icon="film-outline"
                label={t.format}
                value={record.file_format ? String(record.file_format).toUpperCase() : undefined}
              />
              <InfoRow
                icon="sparkles-outline"
                label={t.qualityLabel}
                value={QUALITY_KEYS[record.quality] ? t[QUALITY_KEYS[record.quality]] : undefined}
              />
              <InfoRow icon="code-outline" label={t.mimeType} value={text(record.mimetype)} />
              <InfoRow
                icon="cloud-download-outline"
                label={t.size}
                value={record.file_size_mb ? `${record.file_size_mb} MB` : undefined}
              />
              <InfoRow
                icon="resize-outline"
                label={t.dimensions}
                value={record.width && record.height ? `${record.width} × ${record.height}` : undefined}
                last
              />
            </InfoCard>

            {text(record.note) ? (
              <InfoCard title={t.notes}>
                <View style={styles.note}>
                  <Text style={[styles.noteText, rtlText]}>{record.note}</Text>
                </View>
              </InfoCard>
            ) : null}

            {/* Manager-only, matching the web form where the Audit and AI pages
                both carry groups="…group_cleaning_manager". */}
            {canManage ? (
              <InfoCard title={t.sectionAiReview}>
                <InfoRow
                  icon="ribbon-outline"
                  label={t.aiScore}
                  value={record.ai_score ? String(record.ai_score) : undefined}
                />
                <InfoRow
                  icon="time-outline"
                  label={t.aiReviewedAt}
                  value={formatMoment(record.ai_checked_at)}
                />
                <InfoRow
                  icon="chatbox-ellipses-outline"
                  label={t.aiSummary}
                  value={text(record.ai_summary)}
                  last
                />
              </InfoCard>
            ) : null}

          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    // GradientBackground defaults to flex:1, which here would make this header
    // eat the whole screen. It must be `flex: 0`, not flexGrow/flexShrink of 0:
    // React Native expands `flex: 1` to flexBasis 0, so zeroing only grow and
    // shrink leaves a base height of zero and collapses the header to its
    // padding. `flex: 0` resets flexBasis to auto, so it sizes to its content.
    flex: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  back: { padding: 2 },
  headerText: { flex: 1 },
  title: { fontSize: 18, fontWeight: '700', color: colors.white, letterSpacing: -0.3 },
  subtitle: { fontSize: 12, fontWeight: '500', color: colors.onGradientMuted, marginTop: 1 },
  pill: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
  },
  pillDone: { backgroundColor: colors.glassStrong },
  pillText: { fontSize: 11, fontWeight: '700', color: colors.white },

  body: { padding: spacing.xl, paddingBottom: spacing.xxxl },
  spinner: { marginTop: spacing.xxxl },
  videoFrame: {
    aspectRatio: 16 / 9,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.black,
    marginBottom: spacing.xl,
  },
  video: { width: '100%', height: '100%' },
  videoError: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.xs,
    backgroundColor: 'rgba(15,23,42,0.9)',
  },
  videoErrorTitle: { fontSize: 14, fontWeight: '700', color: colors.white, textAlign: 'center' },
  videoErrorText: {
    fontSize: 12,
    color: colors.onGradientMuted,
    textAlign: 'center',
    lineHeight: 17,
  },
  note: { paddingVertical: spacing.lg },
  noteText: { fontSize: 14, fontWeight: '500', color: colors.text, lineHeight: 20 },
});
