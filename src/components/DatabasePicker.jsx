import React, { useEffect, useRef } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';
/** Read-only row that opens the picker. Mirrors AppTextField's visual shape. */
export function SelectField({ label, value, placeholder, onPress, disabled, hint }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${value ?? placeholder}`}
        style={({ pressed }) => [
          styles.field,
          disabled && styles.fieldDisabled,
          pressed && styles.fieldPressed,
        ]}
      >
        <Ionicons
          name="server-outline"
          size={19}
          color={value ? colors.primary : colors.textMuted}
        />
        <Text style={[styles.value, !value && styles.placeholder]} numberOfLines={1}>
          {value ?? placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </Pressable>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}
export function DatabasePicker({ visible, databases, selected, onSelect, onClose }) {
  const { t, rtlRow, rtlText } = useT();
  const { height } = useWindowDimensions();
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: visible ? 240 : 160,
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [height * 0.5, 0] });
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel="Close database picker"
      >
        {/* Swallow taps on the sheet so they don't dismiss it. */}
        <Pressable onPress={(e) => e.stopPropagation()}>
          <Animated.View
            style={[styles.sheet, { maxHeight: height * 0.7, transform: [{ translateY }] }]}
          >
            <View style={styles.grabber} />
            <Text style={[styles.sheetTitle, rtlText]}>{t.selectDatabase}</Text>
            <Text style={[styles.sheetSubtitle, rtlText]}>
              {databases.length}{' '}
              {databases.length === 1 ? t.databaseFoundOne : t.databasesFoundMany}
            </Text>

            <FlatList
              data={databases}
              keyExtractor={(item) => item}
              style={styles.list}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              renderItem={({ item }) => {
                const active = item === selected;
                return (
                  <Pressable
                    onPress={() => onSelect(item)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={({ pressed }) => [styles.row, rtlRow, pressed && styles.rowPressed]}
                  >
                    <View style={[styles.rowIcon, active && styles.rowIconActive]}>
                      <Ionicons
                        name="cube-outline"
                        size={18}
                        color={active ? colors.white : colors.textSecondary}
                      />
                    </View>
                    <Text
                      style={[styles.rowText, rtlText, active && styles.rowTextActive]}
                      numberOfLines={1}
                    >
                      {item}
                    </Text>
                    {active ? (
                      <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                    ) : null}
                  </Pressable>
                );
              }}
            />
          </Animated.View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: { ...typography.label, marginBottom: spacing.sm },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: 54,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  fieldDisabled: { opacity: 0.5 },
  fieldPressed: { borderColor: colors.primary, backgroundColor: colors.surface },
  value: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  placeholder: { fontWeight: '500', color: colors.textMuted },
  hint: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    marginTop: spacing.sm,
    lineHeight: 16,
  },
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  grabber: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.lg,
  },
  sheetTitle: { ...typography.title },
  sheetSubtitle: { ...typography.caption, marginTop: spacing.xs, marginBottom: spacing.lg },
  list: { flexGrow: 0 },
  separator: { height: 1, backgroundColor: colors.border, marginLeft: 52 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg },
  rowPressed: { opacity: 0.6 },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIconActive: { backgroundColor: colors.primary },
  rowText: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  rowTextActive: { color: colors.primary },
});
