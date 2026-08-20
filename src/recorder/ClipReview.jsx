import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

import { PrimaryButton } from '../components/PrimaryButton';
import { useT } from '../i18n/LanguageProvider';
import { SweepChips } from './SweepChips';
import { colors, radius, spacing, typography } from '../theme';

/** How far a step moves. See the note on the buttons. */
const STEP_SECONDS = 5;

/** "0:07" -- what a camera shows, rather than "7s". */
const clock = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The clip, before it is sent anywhere.
 *
 * A photograph is held and looked at before it is kept; a clip never was. It
 * went straight up, so a sweep that pointed at the floor was only discovered
 * afterwards on Compare - by which time the round is filed, one per slot per
 * day, and needs a manager to delete it before it can be walked again.
 *
 * The view chips move with playback using the same arithmetic that drove them
 * while filming, so what somebody sees here lines up with what they were shown
 * then. No gyroscope tick: nobody is turning, and a mark that cannot change is
 * not worth drawing.
 */
export function ClipReview({
  uri,
  duration,
  roundDuration,
  offset = 0,
  marks,
  onRetake,
  onAccept,
}) {
  const { t, rtlRow, rtlText } = useT();
  const [at, setAt] = useState(0);
  // Guards the double tap. Accepting leaves this screen, but not instantly -
  // the upload has to start first - and two taps would send the round twice.
  const [accepting, setAccepting] = useState(false);
  /** Width of the bar, measured once it is laid out. */
  const trackWidth = useRef(0);
  /** True for the length of a drag. See the responder below. */
  const scrubbing = useRef(false);

  const player = useVideoPlayer(uri, (instance) => {
    // Paused on the first frame: this screen exists to be looked at, and one
    // that starts playing has already moved on before anybody has focused.
    instance.loop = false;
    instance.timeUpdateEventInterval = 0.25;
    instance.pause();
  });

  const { currentTime } = useEvent(player, 'timeUpdate', { currentTime: 0 });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: false });

  // timeUpdate stops arriving while paused, so a seek made with the clip
  // stopped would leave the bar and the chips behind where they were. Ignored
  // mid-drag: a position from the player is where playback IS, and letting it
  // through would haul the thumb back out from under the finger.
  useEffect(() => {
    if (!scrubbing.current) setAt(currentTime || 0);
  }, [currentTime]);

  useEffect(() => {
    const done = player.addListener('playToEnd', () => {
      // Back to the start rather than sitting on a black last frame, so the
      // play button means something without a reset nobody was offered.
      player.currentTime = 0;
      setAt(0);
    });
    return () => done.remove();
  }, [player]);

  /**
   * How long the clip actually is.
   *
   * The player's own figure wins, because the round's `elapsed` is wall-clock -
   * start to finish - and a recording that was paused is shorter than that by
   * however long it was held. Timing the chips by the wall clock would walk
   * them off the end of a paused round. `duration` is the fallback for the
   * moment before the player has read the file.
   */
  const seconds = player.duration || duration || 0;
  const progressPercent = Math.max(0, Math.min(100, seconds ? (at / seconds) * 100 : 0));

  /**
   * How long each view was given, out of the ROUND - never out of the clip.
   *
   * The views were guided against the round's length while filming: ten
   * seconds across three views is 3.3 each, whether or not the recording ran
   * that long. Dividing the clip instead would spread three views across a
   * six-second take and claim all three were covered, when the sweep only
   * reached partway into the second.
   */
  const segment = marks.length ? (roundDuration || seconds) / marks.length : 0;

  /** Where this moment sits in the round, allowing for a continued take. */
  const inRound = offset + at;

  const activeView = useMemo(() => {
    if (!marks.length || !segment) return -1;
    return Math.min(marks.length - 1, Math.floor(inRound / segment));
  }, [inRound, marks.length, segment]);

  /**
   * Whether the clip actually reaches a view.
   *
   * The recording covers the round from `offset` to `offset + seconds`, so a
   * view whose turn came after it stopped has no frame to jump to. Those chips
   * stay on screen and stop responding - the view is part of the round, this
   * take simply never got there.
   */
  const canSelect = (index) => {
    const startsAt = index * segment;
    return startsAt >= offset - 0.01 && startsAt <= offset + seconds + 0.01;
  };

  const seekTo = useCallback(
    (next) => {
      const clamped = Math.max(0, Math.min(seconds, next));
      player.currentTime = clamped;
      setAt(clamped);
    },
    [player, seconds],
  );

  const step = (by) => seekTo(at + by);

  /** Where along the bar the finger is, as a time. */
  const seekAtX = (x) => {
    const width = trackWidth.current;
    if (!width || !seconds) return;
    seekTo((Math.max(0, Math.min(width, x)) / width) * seconds);
  };

  /**
   * Drag the bar, or tap anywhere along it.
   *
   * PanResponder rather than a slider package: nothing to install, which
   * matters while this has to keep running in Expo Go. The grant handler does
   * the same work as a move, so a tap is simply a drag that never moved.
   *
   * `scrubbing` is what stops the player's own timeUpdate fighting the finger:
   * without it, every position that arrives mid-drag drags the thumb back to
   * where playback actually is.
   */
  const scrubber = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Claim the gesture outright. The panel scrolls on some phones, and a
        // horizontal drag on a four-pixel bar is exactly what a ScrollView
        // likes to steal.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => {
          scrubbing.current = true;
          seekAtX(event.nativeEvent.locationX);
        },
        onPanResponderMove: (event) => seekAtX(event.nativeEvent.locationX),
        onPanResponderRelease: () => {
          scrubbing.current = false;
        },
        onPanResponderTerminate: () => {
          scrubbing.current = false;
        },
      }),
    // seekAtX reads refs and the latest seconds through seekTo, so the
    // responder itself never has to be rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seekTo],
  );

  return (
    <View style={styles.screen}>
      <VideoView
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls={false}
        allowsFullscreen={false}
      />

      <View style={styles.panel}>
        <Text style={[styles.title, rtlText]}>{t.reviewRecording}</Text>

        <SweepChips
          marks={marks}
          activeIndex={activeView}
          // Tap a view to see it: the segment start is the first frame the
          // guidance said should show that wall.
          canSelect={canSelect}
          onSelect={(index) => seekTo(index * segment - offset)}
        />

        {/* The bar itself is four pixels; the wrapper is the part a thumb can
            actually land on. */}
        <View
          style={styles.scrubber}
          onLayout={(event) => {
            trackWidth.current = event.nativeEvent.layout.width;
          }}
          {...scrubber.panHandlers}
        >
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${progressPercent}%` }]} />
          </View>
          <View style={[styles.thumb, { left: `${progressPercent}%` }]} />
        </View>

        <View style={[styles.controls, rtlRow]}>
          <Pressable
            onPress={() => step(-STEP_SECONDS)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t.stepBack}
            style={styles.stepBtn}
          >
            <Ionicons name="play-back" size={20} color={colors.white} />
          </Pressable>

          <Pressable
            onPress={() => (isPlaying ? player.pause() : player.play())}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? t.pausePlayback : t.playPlayback}
            style={styles.playBtn}
          >
            <Ionicons name={isPlaying ? 'pause' : 'play'} size={24} color={colors.white} />
          </Pressable>

          <Pressable
            onPress={() => step(STEP_SECONDS)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t.stepForward}
            style={styles.stepBtn}
          >
            <Ionicons name="play-forward" size={20} color={colors.white} />
          </Pressable>

          <Text style={styles.time}>{`${clock(at)} / ${clock(seconds)}`}</Text>
        </View>

        <PrimaryButton
          label={t.useThisClip}
          icon="checkmark"
          onPress={() => {
            if (accepting) return;
            setAccepting(true);
            // Stopped before it leaves: a player left running behind the
            // upload screen holds the decoder and keeps making noise.
            player.pause();
            onAccept();
          }}
          loading={accepting}
          disabled={accepting}
        />
        <PrimaryButton
          label={t.retakeRecording}
          icon="refresh"
          variant="ghost"
          onPress={() => {
            player.pause();
            onRetake();
          }}
          disabled={accepting}
          style={styles.retake}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  video: { flex: 1, backgroundColor: colors.black },
  panel: { padding: spacing.xl, gap: spacing.md, backgroundColor: 'rgba(15,23,42,0.92)' },
  title: { ...typography.heading, color: colors.white, textAlign: 'center' },
  // Tall enough to hit. The bar inside is the part you see; this is the part a
  // thumb lands on, and a four-pixel target is no target at all.
  scrubber: { height: 28, justifyContent: 'center' },
  // Centred on the position rather than starting at it, so the thumb sits over
  // the time it points at instead of just after it.
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: colors.white,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: colors.primary },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  stepBtn: { padding: spacing.sm },
  playBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  time: { ...typography.caption, color: colors.onGradientMuted, minWidth: 78, textAlign: 'right' },
  // Ghost under the filled one: keeping is the ordinary ending, and recording
  // again is the exception worth a moment's pause before pressing.
  retake: { marginTop: -spacing.xs },
});
