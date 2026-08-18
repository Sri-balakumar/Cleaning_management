import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { AuthProvider } from '../src/auth/AuthContext';
import { SplashVideo } from '../src/components/SplashVideo';
import { colors } from '../src/theme';

// Hold the native splash until the animated one has its first frame ready, so
// the two never leave a gap between them.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    // Removes the black root-view flash behind the splash fade on Android.
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'fade',
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          {/* Full-screen over the tabs: both are one focused job, and the
              camera in particular must own the whole screen. */}
          <Stack.Screen
            name="recorder"
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="player/[id]"
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          />
        </Stack>
        {/* Overlays the router so session restore runs underneath the clip. */}
        {splashDone ? null : <SplashVideo onFinish={() => setSplashDone(true)} />}
      </AuthProvider>
    </SafeAreaProvider>
  );
}
