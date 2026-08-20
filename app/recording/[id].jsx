import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import {
  analyseWithAi,
  fetchRecording,
  fetchRecordingShots,
  recomputeMatch,
  videoHeaders,
  videoUrl,
} from '../../src/api/cleaning';
import { fetchAiConfig } from '../../src/api/config';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { bandKey } from '../../src/cleaning/matchBands';
import { useDialog } from '../../src/components/AppDialog';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { InfoCard, InfoRow } from '../../src/components/InfoRow';
import { RoundPhotos } from '../../src/components/RoundPhotos';
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
  const [shots, setShots] = useState([]);
  // Whether the AI review is switched on at all, which decides if any of it is
  // worth showing. Null until known, so nothing flashes up and then vanishes.
  const [aiEnabled, setAiEnabled] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Which action is in flight, so only its own button spins.
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  /** Its own function because the two actions below have to re-read after they
      run: a comparison or a review changes exactly what this screen shows. */
  const load = useCallback(async () => {
    try {
      const row = await fetchRecording(connection.baseUrl, id);
      if (!row) throw new AppError('server', t.recordingNotFound);
      setRecord(row);
      // After the record, and never fatal: a round whose photographs cannot
      // be listed is still a round worth showing.
      const photos = await fetchRecordingShots(connection.baseUrl, id).catch(() => []);
      setShots(photos || []);
      // Never fatal either: not knowing leaves the AI card out, which is the
      // safe way round - better absent than showing scores for a review
      // nobody switched on.
      const ai = await fetchAiConfig(connection.baseUrl).catch(() => null);
      setAiEnabled(!!ai?.enabled);
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setLoading(false);
    }
  }, [connection, id, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // A round need not have a clip at all, and asking for one that was never
  // recorded fetches a 404 and reports it as a playback failure - a fault
  // where nothing is wrong. No filename, no source, nothing requested.
  //
  // The hook below still runs unconditionally, because hooks cannot be called
  // in a branch; with a null source it simply has nothing to fetch.
  const hasVideo = !!record?.video_filename;

  // The video route is permission-checked, so the session cookie has to travel
  // with the request the same way it does on every other call.
  const source = useMemo(
    () =>
      hasVideo
        ? { uri: videoUrl(connection.baseUrl, id), headers: videoHeaders() }
        : null,
    [connection, hasVideo, id],
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

  /**
   * Run a manager action and show whatever the server says about it.
   *
   * Both are refused server-side for anybody who is not a Cleaning Manager, so
   * there is no permission check here - the refusal arrives as the server's own
   * message, which is better wording than anything invented locally.
   */
  const { confirm } = useDialog();

  /**
   * What "Compare again" found, in the words of whoever is holding the phone.
   *
   * The server sends the facts and no sentences: which views moved, and from
   * what to what. Wording them here is the same rule the photographs card
   * already follows - a label from the server arrives in the language of the
   * Odoo account rather than the one chosen in the app.
   */
  const describeChange = useCallback(
    (view) => {
      const level = (key) => t[bandKey(key)];
      const parts = [`${level(view.was_level)} \u2192 ${level(view.now_level)}`];
      // false, not 0, on a side that was never measured - so "none" rather
      // than a nought that reads as the worst possible result.
      if (view.was_score !== false || view.now_score !== false) {
        const score = (v) => (v === false ? t.matchNone : `${v}%`);
        parts.push(`${t.matchLabelShort} ${score(view.was_score)} \u2192 ${score(view.now_score)}`);
      }
      if (view.was_similar !== view.now_similar) {
        parts.push(`${t.similarLabel} ${view.was_similar}% \u2192 ${view.now_similar}%`);
      }
      return `${view.name}\n   ${parts.join('  \u00b7  ')}`;
    },
    [t],
  );

  const compareAgain = useCallback(async () => {
    setBusy('match');
    setError(null);
    setNotice(null);
    try {
      const result = await recomputeMatch(connection.baseUrl, id);
      await load();
      const views = (result && result.views) || [];
      const message = views.length
        ? views.map(describeChange).join('\n\n')
            + (result.unchanged
              ? `\n\n${t.otherViewsUnchanged.replace('%s', result.unchanged)}`
              : '')
        : t.nothingChangedBody;
      confirm({
        title: views.length ? t.viewsChanged : t.nothingChanged,
        message,
        icon: views.length ? 'refresh-outline' : 'checkmark-circle-outline',
        actions: [{ label: t.close, style: 'cancel' }],
      });
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setBusy(null);
    }
  }, [confirm, connection, describeChange, id, load, t]);

  const run = useCallback(
    async (which, work, done) => {
      setBusy(which);
      setError(null);
      setNotice(null);
      try {
        await work();
        await load();
        setNotice(done);
      } catch (e) {
        setError(translateError(t, AppError.from(e)));
      } finally {
        setBusy(null);
      }
    },
    [load, t],
  );

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
          {aiKey && aiEnabled ? (
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
        {notice ? <ErrorBanner message={notice} tone="warning" /> : null}

        {record ? (
          <>
            {hasVideo ? (
              <View style={styles.videoFrame}>
                <VideoView
                  style={styles.video}
                  player={player}
                  // allowsFullscreen is deprecated in favour of this.
                  fullscreenOptions={{ enable: true }}
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
            ) : null}

            {/* The pair the web form has in its header, on the same terms:
                Compare again where there are photographs to re-score, and the
                AI review only where it is switched on and there is something
                for it to look at. Both are manager-only server-side. */}
            {canManage && (shots.length || aiEnabled) ? (
              <View style={[styles.actions, rtlRow]}>
                {shots.length ? (
                  <PrimaryButton
                    label={t.compareAgain}
                    icon="refresh-outline"
                    variant="ghost"
                    loading={busy === 'match'}
                    disabled={!!busy}
                    onPress={compareAgain}
                    style={styles.action}
                  />
                ) : null}
                {aiEnabled && (shots.length || record.frame_count) ? (
                  <PrimaryButton
                    label={t.analyseWithAi}
                    icon="sparkles-outline"
                    loading={busy === 'ai'}
                    disabled={!!busy}
                    onPress={() =>
                      run('ai', () => analyseWithAi(connection.baseUrl, id), t.aiReviewRequested)
                    }
                    style={styles.action}
                  />
                ) : null}
              </View>
            ) : null}

            {/* Above the file details on purpose: the photographs are the
                check, and how they scored is what somebody opened this to find
                out. Absent entirely on a video-only round. */}
            {shots.length ? (
              <InfoCard title={t.sectionPhotographs}>
                <RoundPhotos baseUrl={connection.baseUrl} recordingId={id} shots={shots} />
              </InfoCard>
            ) : null}

            <InfoCard title={t.sectionRound}>
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
              <InfoRow
                icon="stop-outline"
                label={t.endedAt}
                value={formatMoment(record.ended_at)}
                last={!hasVideo}
              />
              {/* Every one of these describes a clip. With none recorded they
                  are zeroes, and a zero reads as a measurement rather than as
                  an absence. */}
              {hasVideo ? (
                <>
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
                </>
              ) : null}
            </InfoCard>

            {hasVideo ? (
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
            ) : (
            /* The same slot in the page, describing what this round actually
               holds. A File card of blanks says nothing; this says how the
               room scored, which is what the round was for. */
            <InfoCard title={t.sectionPhotoDetails}>
              <InfoRow
                icon="images-outline"
                label={t.photographCount}
                value={String(record.shot_count ?? 0)}
              />
              <InfoRow
                icon="speedometer-outline"
                label={t.matchLabel}
                value={record.matched_at ? `${record.match_score}%` : undefined}
              />
              <InfoRow
                icon="stats-chart-outline"
                label={t.matchAverage}
                value={record.matched_at ? `${record.match_score_avg}%` : undefined}
              />
              <InfoRow
                icon="alert-circle-outline"
                label={t.worstView}
                value={text(record.match_worst_label)}
              />
              <InfoRow
                icon="time-outline"
                label={t.comparedAt}
                value={formatMoment(record.matched_at)}
              />
              <InfoRow
                icon="folder-outline"
                label={t.size}
                value={record.file_size_mb ? `${record.file_size_mb} MB` : undefined}
                last
              />
            </InfoCard>
            )}

            {text(record.note) ? (
              <InfoCard title={t.notes}>
                <View style={styles.note}>
                  <Text style={[styles.noteText, rtlText]}>{record.note}</Text>
                </View>
              </InfoCard>
            ) : null}

            {/* Manager-only, matching the web form where the Audit and AI pages
                both carry groups="…group_cleaning_manager". */}
            {/* Manager-only, and only where the review is switched on. A card
                of blanks headed "AI review" reads as a review that failed,
                rather than one nobody asked for. */}
            {canManage && aiEnabled ? (
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
  actions: { flexDirection: 'row', gap: spacing.md },
  action: { flex: 1 },
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
