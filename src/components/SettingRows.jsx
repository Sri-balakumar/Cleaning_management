import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { floatToHm, hmToFloat, formatFloatTime } from '../api/config';
import { useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';

/**
 * The form controls the configuration screens are built from.
 *
 * Deliberately dumb: each takes a value and a setter and reports changes
 * upward. Nothing here validates -- the server owns the rules, and a control
 * that silently corrected a value would hide the message explaining why.
 */

export function ToggleRow({ label, hint, value, onChange, last }) {
  const { rtlRow, rtlText } = useT();
  return (
    <View style={[styles.row, rtlRow, last && styles.rowLast]}>
      <View style={styles.labelCol}>
        <Text style={[styles.label, rtlText]}>{label}</Text>
        {hint ? <Text style={[styles.hint, rtlText]}>{hint}</Text> : null}
      </View>
      <Switch
        value={!!value}
        onValueChange={onChange}
        trackColor={{ true: colors.primary, false: colors.borderStrong }}
        thumbColor={colors.white}
      />
    </View>
  );
}

export function TextRow({
  label,
  hint,
  value,
  onChange,
  placeholder,
  secure = false,
  multiline = false,
  keyboardType,
  suffix,
  last,
}) {
  const { rtlRow, rtlText } = useT();
  const [hidden, setHidden] = useState(secure);

  return (
    <View style={[styles.stack, last && styles.rowLast]}>
      <Text style={[styles.label, rtlText]}>{label}</Text>
      <View style={[styles.inputWrap, rtlRow, multiline && styles.inputWrapTall]}>
        <TextInput
          style={[styles.input, rtlText, multiline && styles.inputMultiline]}
          value={value === false || value === undefined || value === null ? '' : String(value)}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={hidden}
          multiline={multiline}
          keyboardType={keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
        {secure ? (
          <Pressable onPress={() => setHidden((v) => !v)} hitSlop={10}>
            <Ionicons
              name={hidden ? 'eye-outline' : 'eye-off-outline'}
              size={19}
              color={colors.textMuted}
            />
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={[styles.hint, rtlText]}>{hint}</Text> : null}
    </View>
  );
}

export const NumberRow = (props) => (
  <TextRow {...props} keyboardType="number-pad" />
);

/** `options` is `[{ value, label }]`. Opens a sheet rather than a dropdown. */
export function SelectRow({ label, hint, value, options = [], onChange, last }) {
  const { rtlRow, rtlText } = useT();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <View style={[styles.stack, last && styles.rowLast]}>
      <Text style={[styles.label, rtlText]}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.inputWrap, rtlRow, pressed && styles.pressed]}
      >
        <Text style={[styles.input, styles.selectText, rtlText]} numberOfLines={1}>
          {current?.label ?? String(value ?? '')}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </Pressable>
      {hint ? <Text style={[styles.hint, rtlText]}>{hint}</Text> : null}

      <OptionSheet
        visible={open}
        title={label}
        options={options}
        selected={value}
        onSelect={(v) => {
          onChange(v);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

/** Float in, float out — 9.5 is 09:30, the way the server stores it. */
export function TimeRow({ label, value, onChange, last }) {
  const { rtlRow, rtlText } = useT();
  const [open, setOpen] = useState(false);
  const { hour, minute } = floatToHm(value);

  const asDate = new Date();
  asDate.setHours(hour, minute, 0, 0);

  return (
    <View style={[styles.stack, last && styles.rowLast]}>
      <Text style={[styles.label, rtlText]}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.inputWrap, rtlRow, pressed && styles.pressed]}
      >
        <Ionicons name="time-outline" size={18} color={colors.textMuted} />
        <Text style={[styles.input, styles.selectText, rtlText]}>{formatFloatTime(value)}</Text>
      </Pressable>

      {open ? (
        <DateTimePicker
          value={asDate}
          mode="time"
          is24Hour
          onChange={(event, picked) => {
            // Android fires once and dismisses itself; iOS keeps the spinner up.
            setOpen(false);
            if (event.type === 'dismissed' || !picked) return;
            onChange(hmToFloat(picked.getHours(), picked.getMinutes()));
          }}
        />
      ) : null}
    </View>
  );
}

export function OptionSheet({ visible, title, options, selected, onSelect, onClose }) {
  const { height } = useWindowDimensions();
  const { rtlRow, rtlText } = useT();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation()}>
          <View style={[styles.sheet, { maxHeight: height * 0.7 }]}>
            <View style={styles.grabber} />
            <Text style={[styles.sheetTitle, rtlText]}>{title}</Text>
            <FlatList
              data={options}
              keyExtractor={(o) => String(o.value)}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              renderItem={({ item }) => {
                const active = item.value === selected;
                return (
                  <Pressable
                    onPress={() => onSelect(item.value)}
                    style={({ pressed }) => [styles.option, rtlRow, pressed && styles.pressed]}
                  >
                    <Text style={[styles.optionText, rtlText, active && styles.optionActive]}>
                      {item.label}
                    </Text>
                    {active ? (
                      <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                    ) : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  stack: {
    paddingVertical: spacing.lg,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  labelCol: { flex: 1 },
  label: { ...typography.label },
  hint: { ...typography.caption, fontSize: 11, lineHeight: 15 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 46,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  inputWrapTall: { alignItems: 'flex-start', paddingVertical: spacing.md },
  input: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text, paddingVertical: 0 },
  inputMultiline: { minHeight: 90, textAlignVertical: 'top', paddingVertical: 0 },
  selectText: { paddingVertical: 12 },
  suffix: { ...typography.caption, fontWeight: '700' },
  pressed: { opacity: 0.65 },

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
  sheetTitle: { ...typography.title, marginBottom: spacing.md },
  separator: { height: 1, backgroundColor: colors.border },
  option: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.lg },
  optionText: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  optionActive: { color: colors.primary },
});
