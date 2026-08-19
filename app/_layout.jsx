import React, { useEffect, useState } from 'react';
import { Stack, usePathname, useSegments } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { DialogProvider } from '../src/components/AppDialog';
import { LanguageProvider } from '../src/i18n/LanguageProvider';
import { SplashVideo } from '../src/components/SplashVideo';
import { colors } from '../src/theme';
import { log } from '../src/utils/log';

// Hold the native splash until the animated one has its first frame ready, so
// the two never leave a gap between them.
SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Traces every route change next to the auth status that was live at the time.
 * A screen landing on the wrong route is almost always a race between the two,
 * and the pair of values says which one moved first.
 */
function RouteLogger() {
  const pathname = usePathname();
  const segments = useSegments();
  const { status } = useAuth();

  useEffect(() => {
    log('route', pathname, { group: segments.join('/') || '(root)', auth: status });
  }, [pathname, segments, status]);

  return null;
}

export default function RootLayout() {
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    // Removes the black root-view flash behind the splash fade on Android.
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
      <LanguageProvider>
      <AuthProvider>
        {/* Above the router so a confirmation can be raised from any screen,
            and below the splash so it never covers the boot animation. */}
        <DialogProvider>
        <RouteLogger />
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            // Sign-in is a replace, not a push, so a sideways slide would imply a
            // back gesture that does not exist. A rise reads as arriving.
            animation: 'fade_from_bottom',
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          {/* Full-screen over the tabs: both are one focused job, and the
              camera in particular must own the whole screen. */}
          <Stack.Screen
            name="recorder"
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen name="settings/index" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="settings/ai" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen
            name="comparison/[id]"
            options={{ animation: 'slide_from_right' }}
          />
          <Stack.Screen
            name="recording/[id]"
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          />
        </Stack>
        </DialogProvider>
        {/* Overlays the router so session restore runs underneath the clip. */}
        {splashDone ? null : <SplashVideo onFinish={() => setSplashDone(true)} />}
      </AuthProvider>
      </LanguageProvider>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  // Painted under everything. A screen that renders null now shows the app's
  // own background rather than falling through to a black window.
  root: { flex: 1, backgroundColor: colors.background },
});
