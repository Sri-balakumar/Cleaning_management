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

  // A shelf holding both audiences is split under headings, which only a
  // manager ever sees -- they are the only one the server sends both to. Two
  // documents in a flat list leaves them working out which of the two is the
  // one their cleaners get; a heading answers it before they have to ask.
  //
  // One audience, no headings. A user's shelf must not look like a section of
  // something larger, because nothing on it is held back from them, and a
  // manager with only their own document has nothing to tell apart.
  const groups = [
    { key: 'user', label: t.manualsForEveryone },
    { key: 'manager', label: t.manualsForManagers },
  ]
    .map((group) => ({
      ...group,
      rows: manuals.filter((manual) => (manual.audience || 'user') === group.key),
    }))
    .filter((group) => group.rows.length);

  const grouped = groups.length > 1;

  const renderRow = (manual, isLast) => (
    <Pressable
      key={manual.id}
      onPress={() => void onOpen(manual)}
      disabled={busyId !== null}
      accessibilityRole="button"
      accessibilityLabel={manual.name}
      style={({ pressed }) => [
        styles.row,
        rtlRow,
        isLast ? styles.rowLast : null,
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
        {/* Only when there is no heading already saying it. Labelling a row
            that sits under "For managers" says the same thing twice. */}
        {!grouped && manual.audience === 'manager' ? (
          <Text style={[styles.caption, rtlText]}>{t.managersOnly}</Text>
        ) : null}
      </View>
      {busyId === manual.id ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        // The icon says where the tap goes. A document hands off to whatever
        // reads PDFs on this phone, and leaving the app unannounced is what
        // makes people think they have lost their place; a row with no document
        // opens its guide in here, and keeps the chevron that says so.
        <Ionicons
          name={
            manual.has_pdf
              ? 'open-outline'
              : isRTL
                ? 'chevron-back'
                : 'chevron-forward'
          }
          size={18}
          color={colors.textMuted}
        />
      )}
    </Pressable>
  );

  if (!grouped) {
    return manuals.map((manual, index) =>
      renderRow(manual, index === manuals.length - 1));
  }

  return groups.map((group, groupIndex) => (
    <View key={group.key}>
      <Text
        accessibilityRole="header"
        style={[
          styles.groupLabel,
          rtlText,
          groupIndex === 0 ? styles.groupLabelFirst : null,
        ]}
      >
        {group.label}
      </Text>
      {group.rows.map((manual, index) =>
        // The rule under the last row of a group would sit directly above the
        // next heading, reading as its underline rather than as a separator.
        renderRow(manual, index === group.rows.length - 1))}
    </View>
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
  // The token exists for exactly this: "small all-caps section header used
  // above grouped cards".
  groupLabel: { ...typography.overline, marginTop: spacing.lg, marginBottom: spacing.xs },
  // The first heading sits at the top of the card, which already has padding.
  groupLabelFirst: { marginTop: 0 },
  // Matches the "Not set" treatment elsewhere: muted and italic, so an empty
  // shelf never reads as a heading with real content under it.
  empty: { ...typography.body, flex: 1, color: colors.textMuted, fontStyle: 'italic' },
});
