import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../src/api/errors';
import { getDashboardState, getUploadToken, uploadRecording } from '../src/api/cleaning';
import { useAuth } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { formatCountdown } from '../src/cleaning/useSlotClock';
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
  const { t, rtlText } = useT();
  const { slotId } = useLocalSearchParams();

  const [permission, requestPermission] = useCameraPermissions();
  // Never flipped before or during a shot: changing it reconfigures the
  // capture session, which stalls the preview exactly when it is being watched.
  const [mode, setMode] = useState('video');
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState('loading'); // loading|ready|recording|uploading|done
  const [settings, setSettings] = useState(null);
  const [round, setRound] = useState(null);
  const [remaining, setRemaining] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);

  const cameraRef = useRef(null);
  const cancelled = useRef(false);
  const stopRequested = useRef(false);
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
        setSettings(state.settings || {});
        setRemaining(target.seconds_until_close || 0);
        setPhase('ready');
      } catch (e) {
        if (!cancelled.current) {
          setError(translateError(t, AppError.from(e)));
          setPhase('ready');
        }
      }
    })();
  }, [connection, slotId, t]);

  const duration = settings?.duration_seconds || 30;

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

    await send({ video, startedAt, endedAt, elapsed: seconds, frames });
  }, [duration, grabFrame]);

  const send = useCallback(
    async ({ video, startedAt, endedAt, elapsed, frames }) => {
      setPhase('uploading');
      setProgress(0);
      try {
        const csrfToken = await getUploadToken(connection.baseUrl);

        await uploadRecording(
          connection.baseUrl,
          {
            slotId: round.id,
            csrfToken,
            videoUri: video.uri,
            mimetype: 'video/mp4',
            fileFormat: 'mp4',
            startedAt,
            endedAt,
            durationSeconds: elapsed,
            width: settings?.width || 0,
            height: settings?.height || 0,
            // Stopped by hand before the configured length was reached.
            truncated: stopRequested.current && elapsed < duration - 1,
            frames,
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

  return (
    <View style={styles.screen}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={settings?.facing_mode === 'user' ? 'front' : 'back'}
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
              <Text style={styles.help}>
                {`${formatCountdown(duration, t)} ${t.clipWillBeRecorded}`}
              </Text>
              <PrimaryButton
                label={t.startRecording}
                icon="videocam"
                onPress={start}
                disabled={phase === 'loading' || !round}
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
