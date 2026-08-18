import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as SplashScreen from 'expo-splash-screen';
import { colors } from '../theme';

const SOURCE = require('../../assets/splash.mp4');

/** Hard cap: a stalled or undecodable player must never block boot. */
const MAX_DURATION = 4000;
const FADE_DURATION = 350;

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

  const player = useVideoPlayer(SOURCE, (instance) => {
    instance.muted = true;
    instance.loop = false;
    instance.play();
  });

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
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

  return (
    <Animated.View pointerEvents="none" style={[styles.fill, { opacity }]}>
      <StatusBar style="dark" />
      <VideoView
        player={player}
        style={styles.video}
        contentFit="cover"
        nativeControls={false}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.white },
  video: StyleSheet.absoluteFillObject,
});
