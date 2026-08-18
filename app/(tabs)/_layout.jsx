import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../src/auth/AuthContext';
import { useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing } from '../../src/theme';
import { log } from '../../src/utils/log';
/**
 * Material 3 active indicator - the pill that slides under the selected icon in
 * the Android 16 navigation bar. Outlined icon when idle, filled when selected,
 * which is the other half of the M3 selection cue.
 */
function TabIcon({ name, focused, color }) {
  return (
    <View style={[styles.indicator, focused ? styles.indicatorOn : null]}>
      <Ionicons name={focused ? name : `${name}-outline`} size={24} color={color} />
    </View>
  );
}

export default function TabsLayout() {
  const { status } = useAuth();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  // The splash lives on `/`, so render nothing rather than flashing a tab bar.
  if (status === 'restoring') return null;
  if (status !== 'authenticated') {
    log('tabs', 'no session - redirecting to /login');
    return <Redirect href="/login" />;
  }
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        // Screens travel in tab order, so the movement agrees with the pill
        // sliding along the bar. A cross-fade would give no sense of direction.
        animation: 'shift',
        // White on the brand fill, muted white for the tabs that are off.
        tabBarActiveTintColor: colors.white,
        tabBarInactiveTintColor: colors.onGradientMuted,
        // Painted behind the bar so the curve clips it, rather than being the
        // bar's own background colour, which no radius would round.
        tabBarBackground: () => (
          <LinearGradient
            colors={colors.gradientButton}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        ),
        tabBarLabelStyle: styles.label,
        tabBarItemStyle: styles.item,
        // Pinned, not left to the library: with only three short labels it
        // decides they fit on one row and puts the label beside the icon, which
        // drags the label through the active pill.
        tabBarLabelPosition: 'below-icon',
        // M3 puts the bar at 80dp: pill (32) + gap + label, over the inset.
        tabBarStyle: [
          styles.bar,
          { height: 72 + insets.bottom, paddingBottom: insets.bottom + spacing.sm },
        ],
      }}
    >
      <Tabs.Screen
        name="rounds"
        options={{
          title: t.tabRounds,
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="home" focused={focused} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="recordings"
        options={{
          title: t.tabRecordings,
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="videocam" focused={focused} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t.tabProfile,
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="person" focused={focused} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
const styles = StyleSheet.create({
  bar: {
    // The gradient is drawn by tabBarBackground; the bar itself is only the
    // curved window onto it, so it must stay transparent and clip.
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
    paddingTop: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#0F172A',
        shadowOpacity: 0.14,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: -6 },
      },
      // No elevation on Android: it draws its shadow off a solid backing, which
      // would square off the corners the curve just rounded.
      android: { elevation: 0 },
    }),
  },
  item: { paddingTop: 0 },
  indicator: {
    width: 64,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorOn: { backgroundColor: colors.glassStrong },
  // M3 Label Medium, sitting under the pill rather than crowding it.
  label: { fontSize: 12, fontWeight: '600', marginTop: 4, marginBottom: 0 },
});
