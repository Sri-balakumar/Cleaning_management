import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../src/api/errors';
import { getDashboardState, getUploadToken, uploadRecording } from '../src/api/cleaning';
import { useAuth } from '../src/auth/AuthContext';
import { ErrorBanner } from '../src/components/ErrorBanner';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { formatCountdown } from '../src/cleaning/useSlotClock';
import { colors, radius, spacing, typography } from '../src/theme';

/** The camera needs a moment to reconfigure after the mode prop changes. */
const MODE_SETTLE_MS = 450;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Map the server's pixel height onto the camera's quality presets. */
function videoQualityFor(settings) {
  const height = settings?.height || 720;
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  return '480p';
}

export default function RecorderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connection } = useAuth();
  const { slotId } = useLocalSearchParams();

  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState('picture');
  const [phase, setPhase] = useState('loading'); // loading|ready|recording|uploading|done
  const [settings, setSettings] = useState(null);
  const [round, setRound] = useState(null);
  const [remaining, setRemaining] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);

  const cameraRef = useRef(null);
  const cancelled = useRef(false);
  const stopRequested = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  // Ask the server what to record and how, rather than trusting anything the
  // phone already had lying around.
  useEffect(() => {
    void (async () => {
      try {
        const state = await getDashboardState(connection.baseUrl);
        if (cancelled.current) return;
        const target = (state.slots || []).find((s) => String(s.id) === String(slotId));
        if (!target) throw new AppError('server', 'That round is no longer available.');
        if (target.state !== 'open') {
          throw new AppError('server', 'That round is not open for recording right now.');
        }
        setRound(target);
        setSettings(state.settings || {});
        setRemaining(target.seconds_until_close || 0);
        setPhase('ready');
      } catch (e) {
        if (!cancelled.current) {
          setError(AppError.from(e).message);
          setPhase('ready');
        }
      }
    })();
  }, [connection, slotId]);

  const duration = settings?.duration_seconds || 30;

  /**
   * Best-effort still. The camera cannot take one while it is recording, so
   * these are captured either side of the clip -- and a failure here must never
   * cost the recording itself, which is the thing that actually matters.
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
    const startedAt = new Date();

    const frames = [];
    const before = await grabFrame();
    if (before) frames.push(before);

    let video;
    try {
      setMode('video');
      await wait(MODE_SETTLE_MS);
      video = await cameraRef.current?.recordAsync({ maxDuration: duration });
    } catch (e) {
      if (!cancelled.current) {
        setError(AppError.from(e).message || 'The camera could not record.');
        setPhase('ready');
      }
      return;
    }

    const endedAt = new Date();
    if (!video?.uri) {
      if (!cancelled.current) {
        setError('Nothing was recorded. Please try again.');
        setPhase('ready');
      }
      return;
    }

    const after = await grabFrame();
    if (after) frames.push(after);

    const elapsed = (endedAt - startedAt) / 1000;
    await send({ video, startedAt, endedAt, elapsed, frames });
  }, [duration, grabFrame]);

  const send = useCallback(
    async ({ video, startedAt, endedAt, elapsed, frames }) => {
      setPhase('uploading');
      setProgress(0);
      try {
        const csrfToken = await getUploadToken(connection.baseUrl);
        let latitude = 0;
        let longitude = 0;
        try {
          // Nice for the audit trail, never worth failing an upload over.
          const Location = await import('expo-location');
          const granted = await Location.requestForegroundPermissionsAsync();
          if (granted.status === 'granted') {
            const fix = await Location.getCurrentPositionAsync({ accuracy: 3 });
            latitude = fix.coords.latitude;
            longitude = fix.coords.longitude;
          }
        } catch {
          /* no location, carry on */
        }

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
            latitude,
            longitude,
            frames,
          },
          setProgress,
        );
        if (cancelled.current) return;
        setPhase('done');
        router.back();
      } catch (e) {
        if (!cancelled.current) {
          setError(AppError.from(e).message);
          setPhase('ready');
        }
      }
    },
    [connection, duration, round, router, settings],
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
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permText}>
          The app records a short clip to prove the round was done. No sound is recorded.
        </Text>
        <PrimaryButton label="Allow camera" onPress={requestPermission} style={styles.permButton} />
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.cancel}>Cancel</Text>
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
      />

      <View style={[styles.overlay, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl }]}>
        <View style={styles.topBar}>
          <Pressable onPress={() => router.back()} hitSlop={12} disabled={phase === 'uploading'}>
            <Ionicons name="close" size={26} color={colors.white} />
          </Pressable>
          <View style={styles.roundChip}>
            <Text style={styles.roundName}>{round?.name ?? 'Round'}</Text>
            {round ? <Text style={styles.roundWindow}>{round.window_label}</Text> : null}
          </View>
          <View style={{ width: 26 }} />
        </View>

        <View style={styles.bottom}>
          {error ? <ErrorBanner message={error} /> : null}

          {phase === 'uploading' ? (
            <View style={styles.uploading}>
              <Text style={styles.uploadText}>Sending… {Math.round(progress * 100)}%</Text>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(4, progress * 100)}%` }]} />
              </View>
            </View>
          ) : phase === 'recording' ? (
            <>
              <View style={styles.recPill}>
                <View style={styles.recDot} />
                <Text style={styles.recText}>Recording · up to {formatCountdown(duration)}</Text>
              </View>
              <PrimaryButton label="Stop" icon="stop" variant="danger" onPress={stop} />
            </>
          ) : (
            <>
              <Text style={styles.help}>
                {`A ${formatCountdown(duration)} clip will be recorded. No sound.`}
              </Text>
              <PrimaryButton
                label="Start recording"
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
  recText: { fontSize: 12, fontWeight: '600', color: colors.white },
  uploading: { gap: spacing.sm },
  uploadText: { fontSize: 14, fontWeight: '600', color: colors.white, textAlign: 'center' },
  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  fill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.accent },
});
