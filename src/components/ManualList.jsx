import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';

/**
 * One shelf of documents: the rows, the spinner, or the line that says the
 * shelf is empty.
 *
 * Purely presentational. Fetching and opening belong to the screen, because
 * both shelves are filled by a single call and a document opens the same way
 * whichever shelf it came from -- duplicating either here would mean two
 * copies drifting apart.
 *
 * The shelf is never hidden when empty: somebody looking for the manual needs
 * an answer, and a section that quietly disappears is not one.
 */
export function ManualList({ manuals, loading, busyId = null, onOpen }) {
  const { t, rtlRow, rtlText, isRTL } = useT();

  if (loading) {
    return (
      <View style={[styles.row, styles.rowLast, styles.centre]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!manuals.length) {
    return (
      <View style={[styles.row, styles.rowLast, rtlRow]}>
        <View style={styles.icon}>
          <Ionicons name="document-text-outline" size={18} color={colors.textMuted} />
        </View>
        <Text style={[styles.empty, rtlText]}>{t.noManualUploaded}</Text>
      </View>
    );
  }

  return manuals.map((manual, index) => (
    <Pressable
      key={manual.id}
      onPress={() => void onOpen(manual)}
      disabled={busyId !== null}
      accessibilityRole="button"
      accessibilityLabel={manual.name}
      style={({ pressed }) => [
        styles.row,
        rtlRow,
        index === manuals.length - 1 ? styles.rowLast : null,
        pressed ? styles.rowPressed : null,
      ]}
    >
      <View style={styles.icon}>
        <Ionicons name="document-text-outline" size={18} color={colors.primary} />
      </View>
      <View style={styles.titleCol}>
        <Text style={[styles.name, rtlText]} numberOfLines={2}>
          {manual.name}
        </Text>
        {/* Only a manager ever sees a mixed shelf, so this caption only ever
            appears for them. A user's rows carry none, which is the point --
            nothing on their shelf is held back from anyone. */}
        {manual.audience === 'manager' ? (
          <Text style={[styles.caption, rtlText]}>{t.managersOnly}</Text>
        ) : null}
      </View>
      {busyId === manual.id ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        // A chevron rather than an external-link arrow: this opens the guide
        // inside the app. The PDF, which does leave, is a button on the guide.
        <Ionicons
          name={isRTL ? 'chevron-back' : 'chevron-forward'}
          size={18}
          color={colors.textMuted}
        />
      )}
    </Pressable>
  ));
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowPressed: { opacity: 0.6 },
  centre: { justifyContent: 'center' },
  icon: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  titleCol: { flex: 1 },
  name: { ...typography.body },
  caption: { ...typography.caption, marginTop: 2 },
  // Matches the "Not set" treatment elsewhere: muted and italic, so an empty
  // shelf never reads as a heading with real content under it.
  empty: { ...typography.body, flex: 1, color: colors.textMuted, fontStyle: 'italic' },
});
