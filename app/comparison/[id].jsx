import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import { fetchRecording, fetchRecordingShots } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { InfoCard } from '../../src/components/InfoRow';
import { RoundPhotos } from '../../src/components/RoundPhotos';
import { formatDay, formatMoment } from '../../src/cleaning/dates';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';
import { isScored } from '../../src/cleaning/matchBands';

const relationName = (v) => (Array.isArray(v) ? v[1] : undefined);

/**
 * One round's comparison, and nothing else.
 *
 * Deliberately not the recording screen. That one is about the recording - the
 * round card, the file or photograph details, the notes, the AI review - and
 * somebody who tapped a row in Comparisons came for the pictures. The module's
 * comparison form shows none of that either, so the two agree.
 */
export default function ComparisonRoute() {
  return (
    <RequireAuth>
      <ComparisonScreen />
    </RequireAuth>
  );
}

function ComparisonScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [record, setRecord] = useState(null);
  const [shots, setShots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const row = await fetchRecording(connection.baseUrl, id);
        if (cancelled) return;
        if (!row) throw new AppError('server', t.recordingNotFound);
        setRecord(row);
        const photos = await fetchRecordingShots(connection.baseUrl, id).catch(() => []);
        if (!cancelled) setShots(photos || []);
      } catch (e) {
        if (!cancelled) setError(translateError(t, AppError.from(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, id, t]);

  const close = useCallback(() => router.back(), [router]);
  const scored = record?.matched_at && isScored(record?.match_level);

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={[styles.title, rtlText]} numberOfLines={1}>
              {relationName(record?.slot_id) ?? t.round}
            </Text>
            <Text style={[styles.subtitle, rtlText]} numberOfLines={1}>
              {formatDay(record?.slot_date)}
            </Text>
          </View>
        </View>
      </GradientBackground>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: spacing.xxxl + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        {loading ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
        {error ? <ErrorBanner message={error} /> : null}

        {record ? (
          <>
            {/* One line, not a card of rows: the detail screen already carries
                the full breakdown, and what is wanted here is the headline
                before the pictures. */}
            <View style={styles.summary}>
              <Text style={[styles.summaryText, rtlText]}>
                {[
                  scored ? `${t.matchLabelShort}: ${record.match_score}%` : t.matchUnknown,
                  record.match_worst_label ? `${t.worstView}: ${record.match_worst_label}` : null,
                  record.matched_at ? formatMoment(record.matched_at) : null,
                ]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
            </View>

            {shots.length ? (
              <InfoCard title={t.sectionPhotographs}>
                <RoundPhotos baseUrl={connection.baseUrl} recordingId={id} shots={shots} />
              </InfoCard>
            ) : loading ? null : (
              <View style={styles.empty}>
                <Text style={[styles.emptyText, rtlText]}>{t.noComparisonsBody}</Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    // GradientBackground defaults to flex:1, which here would make this header
    // eat the whole screen. It must be `flex: 0`, not flexGrow/flexShrink of 0:
    // React Native expands `flex: 1` to flexBasis 0, so zeroing only grow and
    // shrink leaves a base height of zero and collapses the header to its
    // padding. `flex: 0` resets flexBasis to auto, so it sizes to its content.
    flex: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerText: { flex: 1 },
  title: { fontSize: 22, fontWeight: '700', color: colors.white, letterSpacing: -0.4 },
  subtitle: { ...typography.caption, color: colors.onGradientMuted },

  body: { padding: spacing.xl },
  spinner: { marginTop: spacing.xxxl },
  summary: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  summaryText: { ...typography.body },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyText: { ...typography.caption, textAlign: 'center' },
});
