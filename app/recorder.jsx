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
import { noteServerTime, serverNow } from '../src/cleaning/serverClock';
import { formatCountdown } from '../src/cleaning/useSlotClock';
import { useNavigationBarStyle } from '../src/utils/useNavigationBarStyle';
import { CaptureModeSwitch } from '../src/recorder/CaptureModeSwitch';
import { ClipReview } from '../src/recorder/ClipReview';
import { DirectionCapture } from '../src/recorder/DirectionCapture';
import { SweepChips } from '../src/recorder/SweepChips';
import { useTurnSense } from '../src/recorder/useTurnSense';
import { translateError, useT } from '../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../src/theme';

/**
 * The camera only needs reconfiguring for the single still taken *after*
 * recording. Nothing waits on this before a recording starts.
 */
const MODE_SETTLE_MS = 450;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Monotonic, for the same reason the slot clock is: a recording timed against
 * a wall clock would jump if the phone's clock were corrected mid-round.
 */
const monotonic = () =>
  typeof global.performance?.now === 'function' ? global.performance.now() : Date.now();

/**
 * Whether this phone can pause a recording rather than end it.
 *
 * Android has always been able to; iOS only from 18. Where it cannot, Stop
 * keeps its old meaning and no Continue is offered - a button that silently
 * does nothing is worse than one that is not there.
 */
const PAUSE_AVAILABLE = CameraView.toggleRecordingAsyncAvailable !== false;

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

  // A black camera screen: dark buttons on it are invisible, which is what
  // made the bar look broken on the way in and out of a round.
  useNavigationBarStyle('light');

  const [permission, requestPermission] = useCameraPermissions();
  // What this round is being captured as, where there is a choice at all.
  // Video first: it is the quicker of the two and the reason the choice
  // exists, and somebody who wants the photographs is one tap away.
  const [captureKind, setCaptureKind] = useState('video');
  // Never flipped before or during a shot: changing it reconfigures the
  // capture session, which stalls the preview exactly when it is being watched.
  const [mode, setMode] = useState('video');
  const [elapsed, setElapsed] = useState(0);
  // loading|ready|recording|review|views|uploading|done
  const [phase, setPhase] = useState('loading');
  // Which view is being photographed, and what has been taken so far.
  const [viewIndex, setViewIndex] = useState(0);
  const [photos, setPhotos] = useState([]);
  const [settings, setSettings] = useState(null);
  const [round, setRound] = useState(null);
  const [remaining, setRemaining] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);

  const [paused, setPaused] = useState(false);
  // The finished clip, while it is being looked at. Held in state rather than a
  // ref because the review screen is drawn from it.
  const [clip, setClip] = useState(null);
  // What the next take should run for, and how much of the round is already
  // behind it. Both are the round's own duration and zero for a fresh start,
  // and only differ after somebody chose to carry on from a short take.
  const [nextDuration, setNextDuration] = useState(null);
  const [recordedBefore, setRecordedBefore] = useState(0);

  const cameraRef = useRef(null);
  const cancelled = useRef(false);
  const stopRequested = useRef(false);
  // Recorded time, in two parts: what earlier segments came to, and when the
  // running one began. Paused time belongs to neither, which is the whole
  // point -- the camera excludes it from the clip, so the screen must too.
  //
  // A null `segmentAt` means "not running", which is what lets recordedMs stay
  // a plain function: it never has to read the paused state, and so can never
  // close over a stale copy of it from inside the ticker. Null rather than 0
  // because 0 is a time performance.now() can genuinely return.
  const recorded = useRef(0);
  const segmentAt = useRef(null);
  const recordedMs = () =>
    recorded.current + (segmentAt.current === null ? 0 : monotonic() - segmentAt.current);
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
        // Anchor the server clock before anything is stamped from it. Every
        // timestamp this screen sends is measured against this, never the phone.
        noteServerTime(state);
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
          pending.current = { startedAt: serverNow(), frames: [] };
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
      // Already on the way out with the round sent.
      if (phase === 'uploading' || phase === 'done') return;
      // A clip being recorded is worth just as much as photographs taken, and
      // was the one way out of this screen that never asked.
      const recording = phase === 'recording';
      // Review holds a clip that has not been sent, which is just as lost on
      // the way out as one still being filmed.
      if (!photos.length && !recording && phase !== 'review') return;
      event.preventDefault();
      confirm({
        title: t.leaveRound,
        message: recording ? t.leaveRecordingBody : t.leaveRoundBody,
        icon: 'exit-outline',
        tone: 'danger',
        actions: [
          {
            label: t.leave,
            style: 'destructive',
            onPress: () => {
              // Ended before leaving, or the camera keeps filming to a file
              // nobody will ever ask for. cancelled.current, set by the unmount
              // below, is what stops the clip being acted on when it lands.
              if (recording) cameraRef.current?.stopRecording();
              navigation.dispatch(event.data.action);
            },
          },
          { label: t.cancel, style: 'cancel' },
        ],
      });
    });
    return stop;
  }, [confirm, navigation, phase, photos.length, t]);

  const duration = settings?.duration_seconds || 30;
  // What THIS take runs for. The round's own length, unless somebody chose to
  // carry on from a short one, in which case it is only the time that was left.
  const takeDuration = nextDuration ?? duration;

  /**
   * Whether this round is the person's to choose at all.
   *
   * `video_readable` is the server saying two things at once: the video is
   * switched on, AND this server can actually read a round back out of one.
   * Both are needed. Matching a frame to a view takes feature matching, so
   * without it a video round would upload happily and score nothing - and
   * offering that choice would be offering somebody a worse round.
   *
   * Absent on every older server, which is what keeps this safe: undefined is
   * not true, so those fall through to exactly the behaviour below that they
   * have always had.
   */
  const canChoose = settings?.video_readable === true;

  // A round may be a clip, the photographs, or both - whichever the manager set
  // up. `video_enabled` is read as "not false" so an older server that never
  // sent it still records a clip, exactly as it always did.
  //
  // Where there IS a choice, the person holding the phone has already made it
  // and the setting only said they were allowed to.
  const wantsVideo = canChoose
    ? captureKind === 'video'
    : settings?.video_enabled !== false;

  // A round that is the clip and nothing else - the whole point of the video
  // choice. The views are read out of the recording on the server afterwards,
  // so nobody is asked to photograph them here.
  const videoRound = canChoose && captureKind === 'video';

  const views = useMemo(() => askableViews(settings), [settings]);

  /**
   * How far round each view sits from where the sweep starts.
   *
   * `turn` on each row is the turn from the PREVIOUS view, so the running
   * total is where each one is. The server works the turns out and this only
   * adds them up - the same rule DirectionCapture follows about never
   * calculating a bearing here.
   */
  const sweepMarks = useMemo(() => {
    let total = 0;
    return views.map((row, position) => {
      if (position > 0) total += row.turn?.degrees || 0;
      return { key: row.key, label: row.label, at: total };
    });
  }, [views]);

  /**
   * Which view the clock says to be facing right now.
   *
   * The round's seconds are shared out evenly between the views -- ten seconds
   * across three of them is 3.3 each -- so somebody following the highlight
   * turns at roughly the right moment and the sweep covers everything before
   * the clip runs out. Derived from `elapsed`, which excludes paused time, so a
   * held recording does not march through its views while nothing is filming.
   *
   * Guidance, exactly like the ticks: nothing waits on it and nothing is
   * refused for ignoring it.
   */
  const activeView = useMemo(() => {
    if (!videoRound || !views.length || !duration) return -1;
    const each = duration / views.length;
    // Measured against the ROUND, not this take: a continued one picks up at
    // the view the clock had reached rather than racing every view through
    // whatever seconds are left.
    return Math.min(views.length - 1, Math.floor((recordedBefore + elapsed) / each));
  }, [duration, elapsed, recordedBefore, videoRound, views.length]);

  // Guidance only, and only while a sweep is actually being recorded. See
  // useTurnSense: nothing waits on it, and a phone with no gyroscope simply
  // shows the views without ticking them off.
  const { degrees: turnedBy, available: turnSense } = useTurnSense(
    phase === 'recording' && videoRound,
  );

  const facing = settings?.facing_mode === 'user' ? 'front' : 'back';

  // Video off and not one original set: there is nothing this round could
  // record. The server refuses such a round outright, so the app says so here
  // rather than sending somebody to a refusal.
  const nothingToCapture = !wantsVideo && !views.length;

  /**
   * Change how this round is being captured.
   *
   * Anything already photographed is lost, because the two modes do not
   * produce the same thing and half of each is not a round. So it asks first,
   * with the same dialog leaving a round part-way through uses - and for the
   * same reason, since it is the same loss.
   */
  const switchMode = useCallback(
    (next) => {
      if (next === captureKind) return;
      const apply = () => {
        setError(null);
        setPhotos([]);
        setViewIndex(0);
        pending.current = null;
        setCaptureKind(next);
        setPhase('ready');
      };
      if (!photos.length) {
        apply();
        return;
      }
      confirm({
        title: t.changeCaptureMode,
        message: t.changeCaptureModeBody,
        icon: 'swap-horizontal-outline',
        tone: 'danger',
        actions: [
          { label: t.discardAndChange, style: 'destructive', onPress: apply },
          { label: t.cancel, style: 'cancel' },
        ],
      });
    },
    [captureKind, confirm, photos.length, t],
  );

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
    async ({ video, startedAt, endedAt, elapsed, truncated, frames, photos: taken = [] }) => {
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
            endedAt: endedAt || serverNow(),
            // Only where it was actually chosen. Sending a kind the person was
            // never offered would have the server apply rules to a round that
            // was captured under the old ones.
            captureKind: canChoose ? captureKind : undefined,
            durationSeconds: video ? elapsed : 0,
            width: video ? settings?.width || 0 : 0,
            height: video ? settings?.height || 0 : 0,
            // Stopped by hand before the take's own length was reached. The
            // clip works this out when it is made, so a continuation is judged
            // against the seconds IT was given rather than the round's - four
            // seconds that fill the four that were left is not "cut short".
            truncated: !!video && !!truncated,
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
    [canChoose, captureKind, connection, duration, round, router, settings, t],
  );

  const start = useCallback(async () => {
    setError(null);
    setPhase('recording');
    stopRequested.current = false;
    setElapsed(0);
    setPaused(false);
    recorded.current = 0;
    segmentAt.current = monotonic();
    const startedAt = serverNow();

    // Display only. recordAsync's maxDuration is what actually ends the clip;
    // if this interval were in charge, a slow render would truncate the video.
    //
    // Counts RECORDED time, not wall-clock: a paused round adds nothing while
    // it is paused, which is what the camera itself does with maxDuration, and
    // what makes the readout and the remaining seconds agree.
    ticker.current = setInterval(() => setElapsed(Math.floor(recordedMs() / 1000)), 500);

    let video;
    try {
      video = await cameraRef.current?.recordAsync({ maxDuration: takeDuration });
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

    const endedAt = serverNow();
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
    //
    // Skipped entirely on a video round. The server cuts its own stills out of
    // the recording - two dozen of them, from across the sweep rather than one
    // taken after it stopped - so this would be a shutter fired, a capture
    // session reconfigured and a preview stalled to produce a worse picture
    // than the one already on its way.
    const frames = [];
    if (!videoRound) {
      const still = await grabFrame();
      if (still) frames.push(still);
    }

    // Held and looked at before it goes anywhere, the way a photograph already
    // is. What comes after - the views, or the upload - is decided by the
    // button on that screen rather than here.
    if (!cancelled.current) {
      // `recorded` is the filmed length, which is what the retake dialog counts
      // and what the review screen times its chips by; `elapsed` is wall-clock
      // and stays because the upload reports it as the round's span.
      const filmed = recordedMs() / 1000;
      setClip({
        video,
        startedAt,
        endedAt,
        elapsed: seconds,
        recorded: filmed,
        truncated: stopRequested.current && filmed < takeDuration - 1,
        frames,
      });
      setPhase('review');
    }
  }, [grabFrame, t, takeDuration, videoRound]);

  /** Keep the clip: walk the views if there are any, otherwise send it. */
  const acceptClip = useCallback(async () => {
    const kept = clip;
    if (!kept) return;
    // The views come between the clip and the upload, so the whole round still
    // arrives in one request - except on a video round, which has none to walk.
    if (!videoRound && views.length) {
      pending.current = kept;
      setViewIndex(0);
      setPhotos([]);
      setPhase('views');
      return;
    }
    await send(kept);
  }, [clip, send, videoRound, views.length]);

  /** Throw it away and start again, with the timer back at zero. */
  /** Back to the camera, with the clock set to whatever comes next. */
  const restart = useCallback((secondsToRecord, alreadyDone) => {
    setClip(null);
    setElapsed(0);
    setPaused(false);
    recorded.current = 0;
    segmentAt.current = null;
    stopRequested.current = false;
    setNextDuration(secondsToRecord);
    setRecordedBefore(alreadyDone);
    setPhase('ready');
  }, []);

  /**
   * Throw the clip away and record again.
   *
   * A round that ran its full length goes straight back to the camera - there
   * is nothing to carry over. One that was cut short offers to pick up where
   * it stopped, because the usual reason for stopping early and then not
   * liking the result is having rushed the part that was recorded.
   *
   * "Continue" continues the CLOCK, not the footage: the earlier take is
   * discarded either way. Once stopRecording has closed the file the camera
   * cannot append to it, so keeping both parts would mean joining two videos,
   * which the phone cannot do. What carries over is the time that was left and
   * the view the guidance had reached.
   */
  const retakeClip = useCallback(() => {
    const done = Math.round(recordedBefore + (clip?.recorded ?? 0));
    const left = Math.max(1, duration - done);
    if (!clip?.truncated || left >= duration) {
      restart(duration, 0);
      return;
    }
    confirm({
      title: t.retakeAskTitle,
      message: t.retakeAskBody.replace('{done}', done).replace('{total}', duration),
      icon: 'refresh',
      actions: [
        {
          label: t.retakeContinue.replace('{left}', left),
          onPress: () => restart(left, done),
        },
        {
          label: t.retakeFresh.replace('{total}', duration),
          onPress: () => restart(duration, 0),
        },
        { label: t.cancel, style: 'cancel' },
      ],
    });
  }, [clip, confirm, duration, recordedBefore, restart, t]);

  /**
   * Start a round that is photographs only.
   *
   * There is no clip to time, so the round is timed from the moment they begin
   * walking the views - which is what the server allows for when the video is
   * off.
   */
  const startViews = useCallback(() => {
    setError(null);
    pending.current = { startedAt: serverNow(), frames: [] };
    setViewIndex(0);
    setPhotos([]);
    setPhase('views');
  }, []);

  const onCaptured = useCallback(
    (key, uri) => {
      // Stamped as each one is accepted, so a photographs-only round can be
      // timed by its own work rather than by when the screen happened to open.
      const taken = [...photos.filter((p) => p.key !== key), { key, uri, at: serverNow() }];
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
      const first = stamps.length ? new Date(Math.min(...stamps)) : serverNow();
      const last = stamps.length ? new Date(Math.max(...stamps)) : serverNow();

      void send({
        frames: [],
        ...clip,
        startedAt: clip.video ? clip.startedAt : first,
        endedAt: clip.video ? serverNow() : last,
        photos: taken,
      });
    },
    [photos, send, viewIndex, views.length],
  );

  const stop = useCallback(() => {
    stopRequested.current = true;
    cameraRef.current?.stopRecording();
  }, []);

  /**
   * Hold the recording where it is, and pick it up again.
   *
   * One file either way: the camera pauses the recording rather than ending
   * it, so the paused stretch is simply absent from the clip and maxDuration
   * -- which counts recorded time -- still has the same seconds left when it
   * resumes.
   *
   * Only offered where the platform has it. On iOS that means 18 and above;
   * below that PAUSE_AVAILABLE is false and Stop keeps its old meaning, which
   * is better than a button that quietly does nothing.
   */
  const togglePause = useCallback(async () => {
    try {
      await cameraRef.current?.toggleRecordingAsync();
    } catch (e) {
      // The recording carries on regardless, so this is not worth a banner
      // over the camera preview.
      log('recorder', 'pause toggle refused', AppError.from(e).message);
      return;
    }
    if (segmentAt.current === null) {
      segmentAt.current = monotonic();
      setPaused(false);
    } else {
      recorded.current += monotonic() - segmentAt.current;
      segmentAt.current = null;
      setPaused(true);
    }
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

  // Its own screen for the same reason DirectionCapture gets one: the camera
  // must not be mounted behind it. A preview and a player both want the video
  // pipeline, and holding the camera open while a clip plays is how a preview
  // comes back black on the retake.
  if (phase === 'review' && clip) {
    return (
      <ClipReview
        uri={clip.video.uri}
        duration={clip.recorded || clip.elapsed || takeDuration}
        // The round decides how long each view was given; the clip only decides
        // how much of it there is to watch.
        roundDuration={duration}
        offset={recordedBefore}
        marks={sweepMarks}
        onRetake={retakeClip}
        onAccept={acceptClip}
      />
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
        /* Null rather than false where there is no choice: DirectionCapture
           shows the switch only when it is given one to show, so a server that
           cannot read a recording never offers a mode it cannot score. */
        captureKind={canChoose ? captureKind : null}
        onSwitchMode={canChoose ? switchMode : null}
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
              {/* Which views the sweep has passed, as it passes them.
                  Guidance and nothing else - see useTurnSense. A phone with no
                  gyroscope still shows the list, just without the ticks, which
                  is the difference between "here is what to cover" and a
                  feature that looks broken. */}
              {videoRound && sweepMarks.length ? (
                <SweepChips
                  marks={sweepMarks}
                  activeIndex={activeView}
                  // Only where the phone can actually sense turning: passing a
                  // reading it never takes would tick every view at once.
                  turnedBy={turnSense === false ? null : turnedBy}
                />
              ) : null}
              <View style={styles.recPill}>
                {/* The dot stops pulsing when the recording does, so the state
                    is readable at a glance from across a room. */}
                <Animated.View
                  style={[styles.recDot, paused ? styles.recDotPaused : { opacity: pulse }]}
                />
                <Text style={styles.recText}>
                  {paused ? `${t.recordingPaused} · ` : ''}
                  {clock(elapsed)} / {clock(takeDuration)}
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
              {/* Stop holds the recording rather than ending it, so somebody
                  interrupted mid-round can pick it up where they left off.
                  Finish now is the way out, and only appears once paused -- two
                  buttons while filming is two things to get wrong one-handed. */}
              {PAUSE_AVAILABLE ? (
                paused ? (
                  <>
                    <PrimaryButton
                      label={t.continueRecording}
                      icon="play"
                      onPress={togglePause}
                    />
                    <PrimaryButton
                      label={t.finishNow}
                      icon="stop"
                      variant="danger"
                      onPress={stop}
                      style={styles.secondAction}
                    />
                  </>
                ) : (
                  <PrimaryButton
                    label={t.stop}
                    icon="pause"
                    variant="danger"
                    onPress={togglePause}
                  />
                )
              ) : (
                <PrimaryButton label={t.stop} icon="stop" variant="danger" onPress={stop} />
              )}
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
                    ? `${formatCountdown(takeDuration, t)} ${t.clipWillBeRecorded}`
                    : t.photographsOnlyRound}
              </Text>
              {/* What a video round needs doing differently, said before it
                  starts rather than discovered afterwards from a view that
                  scored nothing. */}
              {videoRound && views.length ? (
                <Text style={styles.help}>{t.sweepEveryView}</Text>
              ) : null}
              {canChoose ? (
                <CaptureModeSwitch
                  value={captureKind}
                  onChange={switchMode}
                  disabled={phase === 'loading'}
                />
              ) : null}
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
  // Finish now sits under Continue rather than beside it: two full-width
  // buttons stack cleanly on a narrow phone held one-handed.
  secondAction: { marginTop: spacing.md },
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
  recDotPaused: { opacity: 1, backgroundColor: colors.onGradientMuted },
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
