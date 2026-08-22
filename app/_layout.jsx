import React, { useEffect, useState } from 'react';
import { Stack, usePathname, useRouter, useSegments } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import * as NavigationBar from 'expo-navigation-bar';
import * as SystemUI from 'expo-system-ui';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { installNotificationHandler } from '../src/push/registerDevice';
import { DialogProvider } from '../src/components/AppDialog';
import { LanguageProvider } from '../src/i18n/LanguageProvider';
import { SplashVideo } from '../src/components/SplashVideo';
import { colors } from '../src/theme';
import { log } from '../src/utils/log';

// Hold the native splash until the animated one has its first frame ready, so
// the two never leave a gap between them.
SplashScreen.preventAutoHideAsync().catch(() => {});

// At module scope, not in an effect: a notification tapped while the app was
// dead is delivered as the app boots, and a handler installed later than that
// misses it.
installNotificationHandler();

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

/**
 * Opening the round a notification was about.
 *
 * Two cases, and only handling the first is the usual mistake. A tap while the
 * app is running arrives through the listener. A tap that LAUNCHED the app
 * from dead has already happened by the time any listener is attached, and is
 * only readable from getLastNotificationResponseAsync -- without that, tapping
 * a notification on a closed phone opens the dashboard and looks broken.
 */
function NotificationTapRouter() {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    // Held until there is a session. Pushing a route while the app is still
    // restoring lands on a screen that immediately redirects to sign-in.
    if (status !== 'authenticated') return undefined;

    const open = (response) => {
      const id = response?.notification?.request?.content?.data?.recordingId;
      if (id) router.push(`/comparison/${id}`);
    };

    let cancelled = false;
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!cancelled && response) open(response);
      })
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [router, status]);

  return null;
}

export default function RootLayout() {
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    // Removes the black root-view flash behind the splash fade on Android.
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});

    // Dark navigation buttons, because every screen but the camera is a light
    // one - and the tab bar paints that strip with the app's own pale
    // background, so light buttons there are invisible. The camera screens ask
    // for light while they are up and hand it back on the way out; this is the
    // state they hand it back to, and the state the app starts in rather than
    // inheriting whatever Android last set.
    try {
      NavigationBar.setStyle('dark');
    } catch {}
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
        <NotificationTapRouter />
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
          <Stack.Screen name="missed" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="notifications" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="help" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="guide/[id]" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="settings/index" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="settings/rounds" options={{ animation: 'slide_from_right' }} />
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
