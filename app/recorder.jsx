import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../src/api/errors';
import { getDashboardState, getUploadToken, uploadRecording } from '../src/api/cleaning';
import { useAuth } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { useDialog } from '../src/components/AppDialog';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { formatCountdown } from '../src/cleaning/useSlotClock';
import { DirectionCapture } from '../src/recorder/DirectionCapture';
import { translateError, useT } from '../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../src/theme';

/**
 * The camera only needs reconfiguring for the single still taken *after*
 * recording. Nothing waits on this before a recording starts.
 */
const MODE_SETTLE_MS = 450;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "0:07" -- what a camera shows, rather than "7s". */
function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The views to photograph, in the order somebody turning on the spot meets
 * them.
 *
 * Filtered by askable_directions as well as taken from directions: the server
 * drops a photograph of a view that has no original, so asking for one would
 * have somebody take a picture that is thrown away. Newer servers already leave
 * those out of `directions`; the intersection also does the right thing against
 * one that does not.
 *
 * At module scope because two places need the same answer from the same data -
 * the render, and the moment the settings arrive and the screen has to decide
 * whether there is anything to show before the camera.
 */
function askableViews(settings) {
  const askable = new Set(settings?.askable_directions || []);
  const rows = settings?.directions || [];
  return askable.size
    ? rows.filter((row) => askable.has(row.key))
    : rows.filter((row) => row.has_reference);
}

/** Map the server's pixel height onto the camera's quality presets. */
function videoQualityFor(settings) {
  const height = settings?.height || 720;
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  return '480p';
}

export default function RecorderRoute() {
  return (
    <RequireAuth>
      <RecorderScreen />
    </RequireAuth>
  );
}

function RecorderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connection } = useAuth();
  const navigation = useNavigation();
  const { confirm } = useDialog();
  const { t, rtlText } = useT();
  const { slotId } = useLocalSearchParams();

  const [permission, requestPermission] = useCameraPermissions();
  // Never flipped before or during a shot: changing it reconfigures the
  // capture session, which stalls the preview exactly when it is being watched.
  const [mode, setMode] = useState('video');
  const [elapsed, setElapsed] = useState(0);
  // loading|ready|recording|views|uploading|done
  const [phase, setPhase] = useState('loading');
  // Which view is being photographed, and what has been taken so far.
  const [viewIndex, setViewIndex] = useState(0);
  const [photos, setPhotos] = useState([]);
  const [settings, setSettings] = useState(null);
  const [round, setRound] = useState(null);
  const [remaining, setRemaining] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);

  const cameraRef = useRef(null);
  const cancelled = useRef(false);
  const stopRequested = useRef(false);
  // The clip, held while the views are photographed, so the whole round still
  // goes up in one request at the end.
  const pending = useRef(null);
  const ticker = useRef(null);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(
    () => () => {
      cancelled.current = true;
      if (ticker.current) clearInterval(ticker.current);
    },
    [],
  );

  // The recording indicator breathes, the way a camera's does.
  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  // Ask the server what to record and how, rather than trusting anything the
  // phone already had lying around.
  useEffect(() => {
    void (async () => {
      try {
        const state = await getDashboardState(connection.baseUrl);
        if (cancelled.current) return;
        const target = (state.slots || []).find((s) => String(s.id) === String(slotId));
        if (!target) throw new AppError('server', t.roundNoLongerAvailable);
        if (target.state !== 'open') throw new AppError('server', t.roundNotOpen);
        setRound(target);
        const resolved = state.settings || {};
        setSettings(resolved);
        setRemaining(target.seconds_until_close || 0);

        // Straight to the first view when there is no clip to record.
        //
        // The ready screen exists to say how long the recording will be and to
        // let somebody brace for it. A photographs-only round has none of that
        // to say, so it was a screen whose only content was a second Capture
        // now button - and they had already tapped Capture now to get here.
        const photosOnly = resolved.video_enabled === false;
        const list = askableViews(resolved);
        if (photosOnly && list.length) {
          pending.current = { startedAt: new Date(), frames: [] };
          setViewIndex(0);
          setPhotos([]);
          setPhase('views');
        } else {
          setPhase('ready');
        }
      } catch (e) {
        if (!cancelled.current) {
          setError(translateError(t, AppError.from(e)));
          setPhase('ready');
        }
      }
    })();
  }, [connection, slotId, t]);

  /**
   * Leaving part-way through discards the photographs, so it asks first.
   *
   * Hooked to the navigator rather than to the close button, because the close
   * button is only one of three doors: the Android back key and the dismiss
   * gesture leave by the same route and would otherwise slip out unasked - and
   * the back key is the one people actually use.
   *
   * Nothing has been uploaded at this point. A round reaches the server in one
   * request at the very end, so abandoning one leaves nothing behind and
   * re-entering starts cleanly at the first view.
   */
  useEffect(() => {
    const stop = navigation.addListener('beforeRemove', (event) => {
      // Nothing to lose, or already on the way out with the round sent.
      if (!photos.length || phase === 'uploading' || phase === 'done') return;
      event.preventDefault();
      confirm({
        title: t.leaveRound,
        message: t.leaveRoundBody,
        icon: 'exit-outline',
        tone: 'danger',
        actions: [
          {
            label: t.leave,
            style: 'destructive',
            onPress: () => navigation.dispatch(event.data.action),
          },
          { label: t.cancel, style: 'cancel' },
        ],
      });
    });
    return stop;
  }, [confirm, navigation, phase, photos.length, t]);

  const duration = settings?.duration_seconds || 30;

  // A round may be a clip, the photographs, or both - whichever the manager set
  // up. `video_enabled` is read as "not false" so an older server that never
  // sent it still records a clip, exactly as it always did.
  const wantsVideo = settings?.video_enabled !== false;

  const views = useMemo(() => askableViews(settings), [settings]);

  const facing = settings?.facing_mode === 'user' ? 'front' : 'back';

  // Video off and not one original set: there is nothing this round could
  // record. The server refuses such a round outright, so the app says so here
  // rather than sending somebody to a refusal.
  const nothingToCapture = !wantsVideo && !views.length;

  /**
   * One still for the AI review, which reads images rather than video.
   *
   * Taken only *after* the clip is finished: the camera cannot capture a still
   * while recording, and doing it beforehand fired a shutter and stalled the
   * preview right as the user pressed record. By the time this runs the video
   * is already safe, so a slow or failed frame costs nothing.
   */
  const grabFrame = useCallback(async () => {
    try {
      setMode('picture');
      await wait(MODE_SETTLE_MS);
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.6 });
      return photo?.uri ?? null;
    } catch {
      return null;
    }
  }, []);

  const send = useCallback(
    async ({ video, startedAt, endedAt, elapsed, frames, photos: taken = [] }) => {
      setPhase('uploading');
      setProgress(0);
      try {
        const csrfToken = await getUploadToken(connection.baseUrl);

        await uploadRecording(
          connection.baseUrl,
          {
            slotId: round.id,
            csrfToken,
            // Every one of these describes a clip. With no clip they are left
            // empty rather than filled in with plausible-looking zeroes that
            // somebody would later read as fact.
            videoUri: video?.uri,
            mimetype: video ? 'video/mp4' : '',
            fileFormat: video ? 'mp4' : '',
            startedAt,
            endedAt: endedAt || new Date(),
            durationSeconds: video ? elapsed : 0,
            width: video ? settings?.width || 0 : 0,
            height: video ? settings?.height || 0 : 0,
            // Stopped by hand before the configured length was reached.
            truncated: !!video && stopRequested.current && elapsed < duration - 1,
            frames,
            photos: taken,
          },
          setProgress,
        );
        if (cancelled.current) return;
        setPhase('done');
        router.back();
      } catch (e) {
        if (!cancelled.current) {
          setError(translateError(t, AppError.from(e)));
          setPhase('ready');
        }
      }
    },
    [connection, duration, round, router, settings, t],
  );

  const start = useCallback(async () => {
    setError(null);
    setPhase('recording');
    stopRequested.current = false;
    setElapsed(0);
    const startedAt = new Date();

    // Display only. recordAsync's maxDuration is what actually ends the clip;
    // if this interval were in charge, a slow render would truncate the video.
    ticker.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.getTime()) / 1000)),
      500,
    );

    let video;
    try {
      video = await cameraRef.current?.recordAsync({ maxDuration: duration });
    } catch (e) {
      if (ticker.current) {
        clearInterval(ticker.current);
        ticker.current = null;
      }
      if (!cancelled.current) {
        setError(translateError(t, AppError.from(e)) || t.cameraCouldNotRecord);
        setPhase('ready');
      }
      return;
    }

    const endedAt = new Date();
    if (ticker.current) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
    if (!video?.uri) {
      if (!cancelled.current) {
        setError(t.nothingWasRecorded);
        setPhase('ready');
      }
      return;
    }

    const seconds = (endedAt - startedAt) / 1000;
    // Safe to do now: the clip exists, so a slow or failed still costs
    // nothing but a moment before the upload begins.
    const frames = [];
    const still = await grabFrame();
    if (still) frames.push(still);

    const clip = { video, startedAt, endedAt, elapsed: seconds, frames };
    // The views come between the clip and the upload, so the whole round still
    // arrives in one request.
    if (views.length) {
      pending.current = clip;
      setViewIndex(0);
      setPhotos([]);
      setPhase('views');
      return;
    }
    await send(clip);
  }, [duration, grabFrame, send, t, views.length]);

  /**
   * Start a round that is photographs only.
   *
   * There is no clip to time, so the round is timed from the moment they begin
   * walking the views - which is what the server allows for when the video is
   * off.
   */
  const startViews = useCallback(() => {
    setError(null);
    pending.current = { startedAt: new Date(), frames: [] };
    setViewIndex(0);
    setPhotos([]);
    setPhase('views');
  }, []);

  const onCaptured = useCallback(
    (key, uri) => {
      // Stamped as each one is accepted, so a photographs-only round can be
      // timed by its own work rather than by when the screen happened to open.
      const taken = [...photos.filter((p) => p.key !== key), { key, uri, at: new Date() }];
      setPhotos(taken);
      if (viewIndex + 1 < views.length) {
        setViewIndex(viewIndex + 1);
        return;
      }
      const clip = pending.current || {};
      pending.current = null;

      // With no clip, the round ran from the first photograph to the last.
      // Opening the screen and walking to the far wall is not the round, and
      // recording both ends as "whenever the upload happened" put an identical
      // started and ended time on every one of them.
      const stamps = taken.map((p) => p.at).filter(Boolean);
      const first = stamps.length ? new Date(Math.min(...stamps)) : new Date();
      const last = stamps.length ? new Date(Math.max(...stamps)) : new Date();

      void send({
        frames: [],
        ...clip,
        startedAt: clip.video ? clip.startedAt : first,
        endedAt: clip.video ? new Date() : last,
        photos: taken,
      });
    },
    [photos, send, viewIndex, views.length],
  );

  const stop = useCallback(() => {
    stopRequested.current = true;
    cameraRef.current?.stopRecording();
  }, []);

  if (!permission) {
    return <Centered><ActivityIndicator color={colors.white} /></Centered>;
  }

  if (!permission.granted) {
    return (
      <Centered>
        <Ionicons name="videocam-off-outline" size={44} color={colors.white} />
        <Text style={styles.permTitle}>{t.cameraAccessNeeded}</Text>
        <Text style={styles.permText}>{t.cameraAccessBody}</Text>
        <PrimaryButton label={t.allowCamera} onPress={requestPermission} style={styles.permButton} />
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.cancel}>{t.cancel}</Text>
        </Pressable>
      </Centered>
    );
  }

  // Its own screen, and the main CameraView is not rendered behind it: two
  // camera previews mounted at once fight over the capture session, and the one
  // that loses shows black.
  if (phase === 'views' && views[viewIndex]) {
    return (
      <DirectionCapture
        baseUrl={connection.baseUrl}
        view={views[viewIndex]}
        index={viewIndex}
        total={views.length}
        facing={facing}
        onCaptured={onCaptured}
        onCancel={() => router.back()}
      />
    );
  }

  return (
    <View style={styles.screen}>
      {/* Only where there is a clip to record.
          On a photographs-only round this camera has nothing to do - it exists
          for the video and the single still taken after it - and mounting it
          anyway was actively harmful: tapping Capture now unmounted it in the
          same frame that DirectionCapture mounted its own, so two cameras
          fought over the hardware during the handover and the first shot came
          back "Failed to capture image". Not mounting it means there is no
          handover at all. */}
      {wantsVideo ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={facing}
          mode={mode}
          videoQuality={videoQualityFor(settings)}
          /* Audio is deliberately never captured, which also avoids asking for
             the microphone at all. */
          mute
          /* The one still is taken after recording and should not announce
             itself with a shutter the user did not ask for. */
          animateShutter={false}
          shutterSound={false}
        />
      ) : null}

      <View style={[styles.overlay, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl }]}>
        <View style={styles.topBar}>
          <Pressable onPress={() => router.back()} hitSlop={12} disabled={phase === 'uploading'}>
            <Ionicons name="close" size={26} color={colors.white} />
          </Pressable>
          <View style={styles.roundChip}>
            <Text style={[styles.roundName, rtlText]}>{round?.name ?? t.round}</Text>
            {round ? <Text style={styles.roundWindow}>{round.window_label}</Text> : null}
          </View>
          <View style={{ width: 26 }} />
        </View>

        <View style={styles.bottom}>
          {error ? <ErrorBanner message={error} /> : null}

          {phase === 'uploading' ? (
            <View style={styles.uploading}>
              <Text style={styles.uploadText}>
                {t.sending} {Math.min(100, Math.round(progress * 100))}%
              </Text>
              <View style={styles.track}>
                <View
                  style={[
                    styles.fill,
                    { width: `${Math.min(100, Math.max(4, progress * 100))}%` },
                  ]}
                />
              </View>
            </View>
          ) : phase === 'recording' ? (
            <>
              <View style={styles.recPill}>
                <Animated.View style={[styles.recDot, { opacity: pulse }]} />
                <Text style={styles.recText}>
                  {clock(elapsed)} / {clock(duration)}
                </Text>
              </View>
              <View style={styles.track}>
                <View
                  style={[
                    styles.fill,
                    styles.fillRec,
                    { width: `${Math.min(100, (elapsed / Math.max(duration, 1)) * 100)}%` },
                  ]}
                />
              </View>
              <PrimaryButton label={t.stop} icon="stop" variant="danger" onPress={stop} />
            </>
          ) : (
            <>
              {/* Says why, rather than handing over a button that does
                  nothing. A round with the video off and no originals set has
                  nothing at all to capture, and "the button is dead" is the
                  least debuggable thing an app can tell somebody. */}
              <Text style={styles.help}>
                {nothingToCapture
                  ? t.nothingToPhotograph
                  : wantsVideo
                    ? `${formatCountdown(duration, t)} ${t.clipWillBeRecorded}`
                    : t.photographsOnlyRound}
              </Text>
              <PrimaryButton
                label={wantsVideo ? t.startRecording : t.startPhotographs}
                icon={wantsVideo ? 'videocam' : 'camera'}
                onPress={wantsVideo ? start : startViews}
                disabled={phase === 'loading' || !round || nothingToCapture}
                loading={phase === 'loading'}
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function Centered({ children }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  centered: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  permTitle: { fontSize: 20, fontWeight: '700', color: colors.white },
  permText: {
    fontSize: 14,
    color: colors.onGradientMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  permButton: { alignSelf: 'stretch' },
  cancel: { ...typography.label, color: colors.onGradientMuted },

  overlay: { flex: 1, justifyContent: 'space-between', paddingHorizontal: spacing.xl },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  roundChip: { alignItems: 'center' },
  roundName: { fontSize: 15, fontWeight: '700', color: colors.white },
  roundWindow: { fontSize: 11, fontWeight: '500', color: colors.onGradientMuted },

  bottom: { gap: spacing.lg },
  help: { fontSize: 13, color: colors.onGradientMuted, textAlign: 'center' },
  recPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(15,23,42,0.6)',
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.lg,
  },
  recDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
  recText: { fontSize: 13, fontWeight: '800', color: colors.white, letterSpacing: 0.5 },
  uploading: { gap: spacing.sm },
  uploadText: { fontSize: 14, fontWeight: '600', color: colors.white, textAlign: 'center' },
  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  fill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.accent },
  fillRec: { backgroundColor: colors.danger },
});
