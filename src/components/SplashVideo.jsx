import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as SplashScreen from 'expo-splash-screen';
import { colors } from '../theme';

const SOURCE = require('../../assets/splash.mp4');

/** Hard cap: a stalled or undecodable player must never block boot. */
const MAX_DURATION = 4000;
const FADE_DURATION = 350;
/** Logo width as a fraction of the screen's shorter edge. Tune to taste. */
const LOGO_SCALE = 0.5;

/**
 * Full-screen animated splash. Sits on top of the router while the logo clip
 * plays, then cross-fades into whatever screen has mounted underneath. The clip
 * opens on white, which is why the native splash background is white too - the
 * handoff between the two is invisible.
 *
 * `onFinish` fires once, after the fade, so the caller can unmount the overlay.
 */
export function SplashVideo({ onFinish }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const dismissed = useRef(false);
  // The surface goes before the fade does. Releasing a video surface can paint
  // black for a frame, and behind the still-opaque backdrop nobody sees it.
  const [showVideo, setShowVideo] = useState(true);

  const player = useVideoPlayer(SOURCE, (instance) => {
    instance.muted = true;
    instance.loop = false;
    instance.play();
  });

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    setShowVideo(false);
    Animated.timing(opacity, {
      toValue: 0,
      duration: FADE_DURATION,
      useNativeDriver: true,
    }).start(() => onFinish?.());
  }, [onFinish, opacity]);

  useEventListener(player, 'playToEnd', dismiss);

  useEventListener(player, 'statusChange', ({ status }) => {
    // The first frame can render, so the native splash has nothing left to hide.
    if (status === 'readyToPlay') SplashScreen.hideAsync().catch(() => {});
    if (status === 'error') dismiss();
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
      dismiss();
    }, MAX_DURATION);
    return () => clearTimeout(timer);
  }, [dismiss]);

  // Sized against the shorter edge so it looks the same on a phone held either
  // way, and on a tablet.
  const { width, height } = useWindowDimensions();
  const size = Math.min(width, height) * LOGO_SCALE;

  return (
    <Animated.View pointerEvents="none" style={[styles.fill, { opacity }]}>
      <StatusBar style="dark" />
      {/*
        `contain` inside a centred box, not `cover` across the whole screen:
        cover scales the clip up until it fills the screen and crops whatever
        does not fit, which blows the logo up far past its intended size. The
        clip opens on white and so does this backdrop, so the letterboxing
        inside the box is invisible.
      */}
      {showVideo ? (
        <VideoView
          player={player}
          style={{ width: size, height: size }}
          contentFit="contain"
          /*
            Not the default surfaceView. That one is a separate native window
            punched through the view hierarchy: it ignores the parent's opacity,
            so the fade above never touches it, and it paints black rather than
            white the moment the surface is released. A textureView draws inside
            the normal hierarchy, so it fades and composites like any other view.
            Costs a little more to draw, which is nothing over a two-second clip.
            Must not be changed at runtime.
          */
            surfaceType="textureView"
            nativeControls={false}
          />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
