import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { videoHeaders, videoUrl } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { colors, spacing, typography } from '../../src/theme';

export default function PlayerScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connection } = useAuth();

  // The video route is permission-checked, so the session cookie has to travel
  // with the request the same way it does on every other call.
  const source = useMemo(
    () => ({ uri: videoUrl(connection.baseUrl, id), headers: videoHeaders() }),
    [connection, id],
  );

  const player = useVideoPlayer(source, (instance) => {
    instance.loop = false;
    instance.play();
  });

  const { status, error } = useEvent(player, 'statusChange', { status: player.status });

  return (
    <View style={styles.screen}>
      <VideoView
        style={styles.video}
        player={player}
        allowsFullscreen
        allowsPictureInPicture
        contentFit="contain"
      />

      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        style={[styles.close, { top: insets.top + spacing.lg }]}
      >
        <Ionicons name="close" size={24} color={colors.white} />
      </Pressable>

      {status === 'error' ? (
        <View style={styles.overlay}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.white} />
          <Text style={styles.title}>This recording could not be played</Text>
          <Text style={styles.text}>
            {error?.message ||
              'The file may have been removed, or you may not have permission to watch it.'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  video: { flex: 1 },
  close: {
    position: 'absolute',
    left: spacing.xl,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.55)',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.md,
    backgroundColor: 'rgba(15,23,42,0.85)',
  },
  title: { fontSize: 17, fontWeight: '700', color: colors.white, textAlign: 'center' },
  text: { ...typography.caption, color: colors.onGradientMuted, textAlign: 'center', lineHeight: 19 },
});
