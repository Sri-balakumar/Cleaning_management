import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  InteractionManager,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchReferenceImageData } from '../api/config';
import { ImageViewer } from '../components/ImageViewer';
import { PrimaryButton } from '../components/PrimaryButton';
import { CaptureModeSwitch } from './CaptureModeSwitch';
import { useTurnSense } from './useTurnSense';
import { useT } from '../i18n/LanguageProvider';
import { useNavigationBarStyle } from '../utils/useNavigationBarStyle';
import { colors, radius, spacing, typography } from '../theme';

/**
 * Close enough. Nobody turns exactly ninety degrees, and holding out for it
 * would leave the meter permanently one nudge short of confirming.
 */
const TOLERANCE = 20;

// Where the target mark sits along the track. Short of the end so there is room
// left to show an overshoot rather than pinning the marker at the finish.
const TARGET_AT = 0.75;

/**
 * Walk one view of the round: face this way, here is how it should look, take
 * the picture.
 *
 * The camera has the whole screen, and the original is a tap away in its own
 * window. Which views the round walks, and how far to turn between them, is the
 * server's answer, read from view.turn and never worked out here.
 *
 * The turn meter is guidance and only guidance -- see useTurnSense. The shutter
 * is live from the moment this opens, whatever the sensor says or fails to say.
 */
export function DirectionCapture({
  baseUrl,
  view,
  index,
  total,
  facing,
  onCaptured,
  onCancel,
  captureKind,
  onSwitchMode,
}) {
  const { t, rtlText } = useT();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef(null);

  // The camera exists only while this screen is the focused one.
  //
  // Without this, leaving a round and coming straight back gave a black preview
  // and a shutter that errored: the departing screen still held the camera for
  // the length of its dismiss animation, so the arriving one opened a session
  // Android had already given away. A screen animating out is not focused, so
  // it drops the camera at once - and an arriving screen waits until it really
  // is the one on top before asking for it.
  const isFocused = useIsFocused();

  const [ready, setReady] = useState(false);
  // Bumped to force a fresh camera when one comes up black anyway.
  const [cameraKey, setCameraKey] = useState(0);
  // True once the screen has stopped animating - see the effect below.
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState(null);
  const [showingOriginal, setShowingOriginal] = useState(false);
  // null, 'capture' (the camera refused) or 'display' (it will not render).
  // Different problems, and the person holding the phone deserves to know which.
  const [shotFailed, setShotFailed] = useState(null);
  // The shot waiting to be accepted, tagged with the view it was taken for.
  // Nothing leaves this screen until it is accepted.
  const [taken, setTaken] = useState(null);

  // A held shot only counts for the view it was taken for.
  //
  // Tagging it and testing the tag here is what makes a stale one unreachable,
  // rather than merely cleared afterwards by an effect: there is no frame in
  // which the previous view's photograph can appear, and no way to accept it
  // under this view's direction. Without it the next view opened already
  // showing the last picture, which read as being asked for the same view
  // twice - and accepting it would have filed a front-wall photograph as the
  // right wall, to be scored against the wrong original ever after.
  const shot = taken && taken.key === view?.key ? taken.uri : null;

  // How far to turn to face this view, and which way, worked out by the server
  // and simply read here. It is absent on the first view - there is nothing to
  // have turned from - and absent from a server too old to send it.
  //
  // Either way that means "no turn to show", and it must NOT fall back to
  // assuming a quarter turn: which views a round walks is the server's to know,
  // and a guess of ninety degrees is exactly the wrong answer for an office
  // with only front and left set up.
  const turn = view?.turn || null;
  const { degrees, available, reset } = useTurnSense(!!turn && !shot);

  const turned = turn ? degrees >= turn.degrees - TOLERANCE : false;
  // Deliberately not clamped at 1. Going past the target is exactly what the
  // marker needs to be able to show.
  const progress = turn ? Math.max(0, degrees / Math.max(turn.degrees, 1)) : 0;

  // Front / Right / Back / Left. The key is fixed forever on the server, so a
  // four-entry map is safe - and it is the one thing the manager's own label
  // ("Systems", "Bags area") deliberately does not say.
  const DIRECTION_NAMES = {
    front: t.dirFront,
    right: t.dirRight,
    back: t.dirBack,
    left: t.dirLeft,
  };

  const referenceId = view?.reference_id;
  useEffect(() => {
    if (!referenceId) return undefined;
    let live = true;
    setOriginal(null);
    fetchReferenceImageData(baseUrl, referenceId)
      // A missing original costs the side-by-side, not the round. They still
      // have the view's name and its instructions to go on.
      .then((data) => live && setOriginal(data))
      .catch(() => {})
      .finally(() => {});
    return () => {
      live = false;
    };
  }, [baseUrl, referenceId]);

  // The camera has to say it is ready again after every remount. Left true
  // across one, the shutter would be live against a camera that is not there.
  useEffect(() => {
    if (!isFocused) {
      setReady(false);
      setSettled(false);
      return undefined;
    }
    const task = InteractionManager.runAfterInteractions(() => setSettled(true));
    return () => task.cancel();
  }, [isFocused]);

  // Light navigation buttons while this black screen is up. The reasoning, and
  // the guards, live in the hook - which the recorder screen needs too, and
  // was the reason its buttons went missing on the way in and out of here.
  useNavigationBarStyle('light');

  /** Force a fresh camera. Insurance for a preview that comes up black anyway. */
  const restartCamera = useCallback(() => {
    setReady(false);
    setShotFailed(null);
    setCameraKey((n) => n + 1);
  }, []);

  // Start every view clean: no shot held over, and the turn measured from
  // wherever the last one finished.
  //
  // This screen is not remounted between views - the same component is handed a
  // new `view`, which keeps the camera session alive so the shutter is ready
  // the moment somebody has turned. The cost is that its state survives the
  // change unless it is cleared here, and a held-over `shot` is not a cosmetic
  // problem: the screen would open the next view already showing the PREVIOUS
  // photograph, and accepting it would file that picture under this view's
  // direction - a front-wall photograph stored and scored as the right wall.
  useEffect(() => {
    setTaken(null);
    setShotFailed(null);
    reset();
    // reset is stable enough for this: it only touches refs and one setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.key]);

  // Held, not sent. A round is one per slot per day, so a blurry shot or a
  // thumb over the lens would otherwise be unfixable - the round is spent, and
  // the mistake only turns up later as a match score nobody can account for.
  const accept = useCallback(() => {
    if (shot) onCaptured(view.key, shot);
  }, [onCaptured, shot, view?.key]);

  const retake = useCallback(() => {
    setTaken(null);
    setShotFailed(null);
    // They have not turned anywhere between the two shots.
    reset();
  }, [reset]);

  const capture = useCallback(async () => {
    if (busy) return;
    // Two different faults, and the optional-chained call below reported them
    // identically: no camera mounted returned undefined, exactly as a live
    // camera refusing would. They need different things done about them.
    if (!ready || !cameraRef.current) {
      setShotFailed('notready');
      return;
    }
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        // No base64: this one goes up as a file part on the multipart upload,
        // the way the video and the stills do. Encoding it would put four more
        // megabytes through the bridge for nothing.
        //
        // skipProcessing stays off as well - the server compares an upright
        // picture, and a sideways one would score against a rotated room.
      });
      if (photo?.uri) {
        setShotFailed(null);
        setTaken({ key: view.key, uri: photo.uri });
      } else {
        setShotFailed('capture');
      }
    } catch {
      // The camera itself refused. Without this the rejection escaped as an
      // uncaught promise, the shutter appeared to do nothing at all, and the
      // only sign anything had happened was a stack trace in the log - which
      // is no use whatsoever to somebody standing in a showroom.
      setShotFailed('capture');
    } finally {
      setBusy(false);
    }
    // view.key is a real dependency: it is what the shot gets tagged with, and
    // a stale one here would tag the picture with the view before this one.
  }, [busy, ready, view?.key]);

  return (
    <View style={styles.screen}>
      {/* The camera while composing; the photograph alone once it is taken,
          at the size worth judging it at. */}
      <View style={styles.stage}>
        {/* The camera stays mounted for the whole round, with the photograph
            laid OVER it while it is being judged.

            Not swapped out, which is what turned the review black: unmounting
            the camera in the same render that sets the shot tears the native
            module down while it may still be finishing the file, and an Image
            whose source fails to load draws nothing at all - leaving the black
            behind it looking like the photograph. Keeping it mounted also
            makes Retake instant, instead of waiting on the camera to warm up
            and report ready all over again. */}
        {/* Focused AND settled. Creating a preview surface while the screen is
            still sliding up is a reliable way to get a black one on Android,
            and this screen is entered straight from the dashboard now - so the
            animation and the camera were racing, which is why the black came
            and went. InteractionManager is the platform's own "wait until the
            animations have finished". */}
        {isFocused && settled ? (
          <CameraView
            key={cameraKey}
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            mode="picture"
            onCameraReady={() => setReady(true)}
          />
        ) : null}

        {/* Says what it is waiting for. A bare black rectangle cannot be told
            apart from a camera that has failed. */}
        {!shot && !ready ? (
          <View style={styles.starting}>
            <ActivityIndicator color={colors.white} />
            <Text style={styles.startingText}>{t.startingCamera}</Text>
          </View>
        ) : null}

        {shot ? (
          <Image
            source={{ uri: shot }}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            // Says so out loud rather than showing a black rectangle and
            // letting somebody accept a photograph nobody can see.
            onError={() => setShotFailed('display')}
          />
        ) : original ? (
          /* The original is one tap away rather than permanently beside the
             camera. Half a phone width is not a viewfinder - you cannot line a
             room up in it - and it left the original too small to compare
             against either, so both halves failed at their own job. */
          <Pressable
            onPress={() => setShowingOriginal(true)}
            accessibilityRole="button"
            accessibilityLabel={t.theOriginal}
            style={[styles.originalBtn, { top: insets.top + spacing.md }]}
          >
            <Ionicons name="image-outline" size={15} color={colors.white} />
            <Text style={styles.originalBtnText}>{t.theOriginal}</Text>
          </Pressable>
        ) : null}

        {/* Last in the stage, so it sits above the preview rather than under
            it. The only way out: this screen is entered directly on a
            photographs-only round, so without it somebody who opened the wrong
            round would have to finish it to escape. */}
        {onCancel ? (
          <Pressable
            onPress={onCancel}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t.cancel}
            style={[styles.closeBtn, { top: insets.top + spacing.md }]}
          >
            <Ionicons name="close" size={24} color={colors.white} />
          </Pressable>
        ) : null}

        {shotFailed ? (
          <View style={styles.shotFailed}>
            <Ionicons name="alert-circle" size={22} color={colors.white} />
            <Text style={styles.shotFailedText}>
              {shotFailed === 'display'
                ? t.photoCouldNotBeShown
                : shotFailed === 'notready'
                  ? t.cameraNotReady
                  : t.photoCouldNotBeTaken}
            </Text>
            {/* An intermittent native preview failure cannot be prevented from
                here, so there is at least a way back from it that is not
                abandoning the round. */}
            <Pressable onPress={restartCamera} hitSlop={8} accessibilityRole="button">
              <Text style={styles.restartText}>{t.restartCamera}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.info}>
        {/* The numbers stay out of the dictionary: every entry in it is a
            plain string, and one function value would start a second kind. */}
        <Text style={styles.step}>{`${t.stepLabel} ${index + 1}/${total}`}</Text>

        {/* Which way to face, said plainly and before anything else. The
            manager's own name for the view sits under it: that says what is in
            the view, this says where to stand. */}
        <View style={styles.dirRow}>
          {turn ? (
            <Ionicons
              name={turn.clockwise ? 'arrow-forward' : 'arrow-back'}
              size={26}
              color={colors.white}
            />
          ) : null}
          <Text style={styles.dirWord}>{DIRECTION_NAMES[view.key] || view.label}</Text>
        </View>

        <Text style={[styles.viewName, rtlText]}>{view.label}</Text>
        {view.instructions ? (
          <Text style={[styles.instructions, rtlText]}>{view.instructions}</Text>
        ) : null}
      </View>

      {/* Shown wherever the server said there is a turn, and not while a shot
          is being judged - by then the turning is done.
          Not gated on the sensor working. Hiding the whole thing when the
          gyroscope cannot answer is indistinguishable from the feature being
          broken, which is exactly how it looked: no track, no message, nothing
          to tell you the phone simply has nothing to measure with. */}
      {turn && !shot ? (
        <View style={styles.turn}>
          <View style={styles.turnRow}>
            <Ionicons
              name={
                available === false
                  ? 'information-circle-outline'
                  : turned
                    ? 'checkmark-circle'
                    : 'arrow-forward-circle-outline'
              }
              size={20}
              color={turned && available ? colors.success : colors.white}
            />
            <Text style={[styles.turnText, turned && available && styles.turnTextDone]}>
              {available === false
                ? t.turnSenseUnavailable
                : turned
                  ? t.facingTheView
                  : t.keepTurning}
            </Text>
          </View>
          {/* A track with the target fixed at three quarters and a marker that
              slides along it, rather than a bar that fills.
              "How far round am I, and where should I be" is the question
              somebody turning on the spot is asking, and a percentage cannot
              answer it. The target sits short of the end on purpose: past it is
              overshoot, and a marker that stopped dead at the end of the track
              could not show that you had gone too far - which is the one thing
              a guide like this is for. */}
          {available ? (
            <>
              <View style={styles.track}>
                <View style={[styles.trackTarget, turned && styles.trackTargetDone]} />
                <View
                  style={[
                    styles.marker,
                    { left: `${Math.min(99, progress * TARGET_AT * 100)}%` },
                    turned && styles.markerDone,
                  ]}
                />
              </View>
              <Text style={styles.trackDegrees}>
                {`${Math.round(Math.min(degrees, turn.degrees * 2))}° / ${turn.degrees}°`}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}

      {/* The inset is reserved here, not assumed away. Edge-to-edge draws the
          app behind the system navigation buttons, so without it Retake and
          Use it sit underneath them and get pressed by mistake. */}
      <View style={[styles.controls, { paddingBottom: insets.bottom + spacing.xl }]}>
        {/* Photos or video, over the camera, the way a phone's own camera app
            puts it there. Hidden while a shot is being judged: the question
            then is whether to keep THIS picture, and offering to throw the
            whole round away beside Retake and Use it is the wrong question in
            the wrong place. */}
        {onSwitchMode && !shot ? (
          <CaptureModeSwitch
            value={captureKind}
            onChange={onSwitchMode}
            disabled={busy}
            style={styles.modeSwitch}
          />
        ) : null}
        {shot ? (
          <View style={styles.review}>
            <PrimaryButton
              label={t.retakePhoto}
              icon="refresh-outline"
              variant="ghost"
              onPress={retake}
              style={styles.reviewBtn}
            />
            <PrimaryButton
              label={t.useThisPhoto}
              icon="checkmark"
              onPress={accept}
              style={styles.reviewBtn}
            />
          </View>
        ) : (
          <Pressable
            onPress={capture}
            disabled={!ready || busy}
            accessibilityRole="button"
            accessibilityLabel={t.takePhoto}
            style={[styles.shutter, (!ready || busy) && styles.shutterOff]}
          >
            {busy ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <View style={styles.shutterCore} />
            )}
          </Pressable>
        )}
      </View>

      {/* The original in its own window, full size on black - the size worth
          comparing at. The same component the settings editor and the round
          Photographs card use. */}
      <ImageViewer
        visible={showingOriginal}
        base64={original}
        title={view?.label}
        onClose={() => setShowingOriginal(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  // Black behind, so a photograph shown with resizeMode contain
  // letterboxes onto it rather than onto whatever was underneath.
  stage: { flex: 1, backgroundColor: colors.black },
  fill: { width: '100%', height: '100%' },
  shotFailed: {
    position: 'absolute',
    left: spacing.xl,
    right: spacing.xl,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.danger,
  },
  restartText: { ...typography.caption, color: colors.white, fontWeight: '700', textDecorationLine: 'underline' },
  starting: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  startingText: { ...typography.caption, color: colors.white },
  shotFailedText: { ...typography.caption, color: colors.white, flex: 1 },
  closeBtn: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
  },
  originalBtn: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
  },
  originalBtnText: { fontSize: 12, fontWeight: '700', color: colors.white },

  info: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.xs },
  step: { ...typography.caption, color: colors.onGradientMuted, textAlign: 'center' },
  viewName: { ...typography.title, color: colors.white, textAlign: 'center' },
  instructions: {
    ...typography.body,
    color: colors.onGradientMuted,
    textAlign: 'center',
  },

  turn: { paddingHorizontal: spacing.xxl, paddingTop: spacing.lg, gap: spacing.sm },
  turnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  turnText: { ...typography.body, color: colors.white },
  turnTextDone: { color: colors.success },
  track: {
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
    justifyContent: 'center',
  },
  trackTarget: {
    position: 'absolute',
    left: '75%',
    width: 3,
    top: 4,
    bottom: 4,
    borderRadius: 2,
    backgroundColor: colors.onGradientMuted,
  },
  trackTargetDone: { backgroundColor: colors.success },
  marker: {
    position: 'absolute',
    width: 22,
    height: 22,
    marginLeft: -11,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  markerDone: { backgroundColor: colors.success },
  trackDegrees: { ...typography.caption, color: colors.onGradientMuted, textAlign: 'center' },

  modeSwitch: { marginBottom: spacing.lg },
  controls: { alignItems: 'center', paddingTop: spacing.xl, paddingHorizontal: spacing.xl },
  review: { flexDirection: 'row', gap: spacing.md, alignSelf: 'stretch' },
  reviewBtn: { flex: 1 },
  dirRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  dirWord: { fontSize: 26, fontWeight: '800', color: colors.white, letterSpacing: -0.3 },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: radius.pill,
    borderWidth: 4,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterOff: { opacity: 0.4 },
  shutterCore: { width: 56, height: 56, borderRadius: radius.pill, backgroundColor: colors.white },
});
