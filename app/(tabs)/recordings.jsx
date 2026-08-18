import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import { fetchRecordings } from '../../src/api/cleaning';
import { useAuth } from '../../src/auth/AuthContext';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { colors, radius, spacing, typography } from '../../src/theme';

/** Odoo hands back naive UTC: "YYYY-MM-DD HH:MM:SS". */
function formatWhen(value) {
  if (!value) return '';
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const relationName = (value) => (Array.isArray(value) ? value[1] : '');

export default function RecordingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // No role filter here: the server already decides whether this person
      // sees only their own recordings or everybody's.
      const result = await fetchRecordings(connection.baseUrl);
      setRows(result || []);
    } catch (e) {
      setError(AppError.from(e).message);
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.xl }]}>
        <GradientOrbs />
        <Text style={styles.title}>Recordings</Text>
        <Text style={styles.subtitle}>
          {rows.length ? `${rows.length} shown` : 'Clips you are allowed to see'}
        </Text>
      </GradientBackground>

      <FlatList
        data={rows}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshing={loading}
        onRefresh={load}
        ListHeaderComponent={error ? <ErrorBanner message={error} /> : null}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🎬</Text>
              <Text style={styles.emptyTitle}>Nothing here yet</Text>
              <Text style={styles.emptyText}>
                Recordings appear once a round has been recorded.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/player/${item.id}`)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.thumb}>
              <Ionicons name="play" size={18} color={colors.primary} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {relationName(item.slot_id) || 'Round'}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {formatWhen(item.started_at)} · {relationName(item.user_id)}
              </Text>
              <Text style={styles.rowMeta}>
                {item.duration_seconds}s · {String(item.file_format || '').toUpperCase()}
                {item.file_size_mb ? ` · ${item.file_size_mb} MB` : ''}
                {item.truncated ? ' · cut short' : ''}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.white, letterSpacing: -0.4 },
  subtitle: { fontSize: 13, fontWeight: '500', color: colors.onGradientMuted, marginTop: 2 },
  list: { padding: spacing.xl, gap: spacing.md },
  spinner: { marginTop: spacing.xxxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  pressed: { opacity: 0.7 },
  thumb: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  rowMeta: { ...typography.caption },
  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.title },
  emptyText: { ...typography.caption, textAlign: 'center' },
});
