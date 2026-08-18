import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, typography } from '../theme';
export function InfoRow({ icon, label, value, empty = 'Not set', last = false }) {
  const missing = !value;
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <View style={styles.iconBox}>
        <Ionicons name={icon} size={17} color={colors.primary} />
      </View>
      <View style={styles.textCol}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, missing && styles.valueMissing]} selectable={!missing}>
          {value || empty}
        </Text>
      </View>
    </View>
  );
}
export function InfoCard({ title, children }) {
  return (
    <View style={styles.cardWrap}>
      <Text style={styles.cardTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}
const styles = StyleSheet.create({
  cardWrap: { marginBottom: spacing.xl },
  cardTitle: { ...typography.overline, marginBottom: spacing.md, marginLeft: spacing.xs },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    shadowColor: '#0F172A',
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: { flex: 1 },
  label: { ...typography.caption, marginBottom: 2 },
  value: { fontSize: 15, fontWeight: '600', color: colors.text },
  valueMissing: { fontWeight: '500', color: colors.textMuted, fontStyle: 'italic' },
});
