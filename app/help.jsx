import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../src/api/errors';
import { fetchManuals } from '../src/api/manual';
import { useAuth } from '../src/auth/AuthContext';
import { RequireAuth } from '../src/auth/RequireAuth';
import { GradientBackground, GradientOrbs } from '../src/components/GradientBackground';
import { ManualList } from '../src/components/ManualList';
import { useT } from '../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../src/theme';
import { log } from '../src/utils/log';

/**
 * Help: the guides written for the app.
 *
 * One shelf, straight onto the screen. The server also holds documentation for
 * the module itself, but that belongs in the backend where somebody is
 * configuring it -- keeping it here would mean a heading to open before
 * reaching anything, and a phone is not where a reverse proxy gets set up.
 *
 * Open to everyone who can sign in. The server decides which guides each person
 * may see, which is not a decision worth second-guessing from here.
 */
export default function HelpRoute() {
  return (
    <RequireAuth>
      <HelpScreen />
    </RequireAuth>
  );
}

function HelpScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [manuals, setManuals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!connection) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchManuals(connection.baseUrl);
        if (!cancelled) setManuals(Array.isArray(rows) ? rows : []);
      } catch (e) {
        // The shelf simply reads as empty. Nothing here is worth an error
        // banner: they came looking for a guide, and "there are none" is the
        // answer either way.
        log('manual', 'list unavailable', AppError.from(e).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // The module's own documentation is dropped here rather than on the server,
  // because the same call also feeds the backend's guide pages.
  const appManuals = useMemo(
    () => manuals.filter((manual) => manual.section !== 'manual'),
    [manuals],
  );

  // The guide, not the document. Most questions are answered by the guide, and
  // the PDF behind it is one button further on for whoever wants all of it.
  const open = useCallback((manual) => router.push(`/guide/${manual.id}`), [router]);

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]}>{t.help}</Text>
        </View>
      </GradientBackground>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: spacing.xxxl + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <ManualList manuals={appManuals} loading={loading} onOpen={open} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    // GradientBackground defaults to flex:1, which here would make this header
    // eat the whole screen. Same note as on the Missed and History headers.
    flex: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { ...typography.title, color: colors.white, letterSpacing: -0.4 },
  body: { padding: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
  },
});
