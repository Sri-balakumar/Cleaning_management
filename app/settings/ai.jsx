import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import {
  createAiCheck,
  deleteAiCheck,
  fetchAiChecks,
  fetchAiConfig,
  writeAiCheck,
  writeAiConfig,
} from '../../src/api/config';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { useDialog } from '../../src/components/AppDialog';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { InfoCard } from '../../src/components/InfoRow';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { NumberRow, SelectRow, TextRow, ToggleRow } from '../../src/components/SettingRows';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';

/** Kept in step with DEFAULT_MODELS on the server. */
const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
  ollama: 'llama3.2-vision',
  openai_compatible: '',
};

export default function AiSettingsRoute() {
  return (
    <RequireAuth>
      <AiSettingsScreen />
    </RequireAuth>
  );
}

function AiSettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();
  const { confirm } = useDialog();

  const [config, setConfig] = useState(null);
  const [checks, setChecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const cfg = await fetchAiConfig(connection.baseUrl);
      setConfig(cfg);
      if (cfg) setChecks((await fetchAiChecks(connection.baseUrl, cfg.id)) || []);
    } catch (e) {
      setError(translateError(t, AppError.from(e)));
    } finally {
      setLoading(false);
    }
  }, [connection, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch) => setConfig((c) => ({ ...c, ...patch }));

  const run = useCallback(
    async (work) => {
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        await work();
        await load();
        setNotice(t.saved);
      } catch (e) {
        setError(translateError(t, AppError.from(e)));
      } finally {
        setSaving(false);
      }
    },
    [load, t],
  );

  const save = () =>
    run(() =>
      writeAiConfig(connection.baseUrl, config.id, {
        enabled: !!config.enabled,
        provider: config.provider,
        base_url: config.base_url || false,
        api_key: config.api_key || false,
        model: config.model || false,
        frames_per_recording: Number(config.frames_per_recording) || 0,
        timeout_seconds: Number(config.timeout_seconds) || 0,
        max_output_tokens: Number(config.max_output_tokens) || 0,
        extra_instructions: config.extra_instructions || false,
      }),
    );

  const addCheck = () =>
    run(() =>
      createAiCheck(connection.baseUrl, {
        config_id: config.id,
        name: t.newCheck,
        active: true,
      }),
    );

  const removeCheck = (check) =>
    confirm({
      title: t.deleteCheck,
      message: check.name,
      icon: 'trash-outline',
      tone: 'danger',
      actions: [
        {
          label: t.delete,
          style: 'destructive',
          onPress: () => void run(() => deleteAiCheck(connection.baseUrl, check.id)),
        },
        { label: t.cancel, style: 'cancel' },
      ],
    });

  // Exactly the server's selection values. 'openai' is not one of them and a
  // write carrying it would be refused.
  const providerOptions = [
    { value: 'gemini', label: t.providerGemini },
    { value: 'ollama', label: t.providerOllama },
    { value: 'openai_compatible', label: t.providerOpenAiCompatible },
  ];

  /**
   * Mirrors the server's @api.onchange('provider'): picking a provider
   * suggests the model that suits it, points Ollama at its usual local
   * address, and clears the base URL for Gemini, which does not take one.
   */
  const onProviderChange = (value) => {
    const patch = { provider: value, model: DEFAULT_MODELS[value] ?? '' };
    if (value === 'ollama' && !config.base_url) patch.base_url = 'http://localhost:11434';
    if (value === 'gemini') patch.base_url = '';
    set(patch);
  };

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]}>{t.sectionAiReview}</Text>
        </View>
      </GradientBackground>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: spacing.xxxl + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
        {error ? <ErrorBanner message={error} /> : null}
        {notice ? <ErrorBanner message={notice} tone="warning" /> : null}

        {!loading && !config ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>✨</Text>
            <Text style={styles.emptyTitle}>{t.nothingSetUp}</Text>
          </View>
        ) : null}

        {config ? (
          <>
            <InfoCard title={t.sectionAiReview}>
              <ToggleRow
                label={t.aiEnabled}
                hint={t.aiEnabledHint}
                value={config.enabled}
                onChange={(v) => set({ enabled: v })}
                last={!config.enabled}
              />
            </InfoCard>

            {config.enabled ? (
              <>
                <InfoCard title={t.aiWhereItRuns}>
                  <SelectRow
                    label={t.aiProvider}
                    value={config.provider}
                    options={providerOptions}
                    onChange={onProviderChange}
                  />
                  <TextRow
                    label={t.aiBaseUrl}
                    value={config.base_url}
                    onChange={(v) => set({ base_url: v })}
                    placeholder="https://…"
                  />
                  <TextRow
                    label={t.aiApiKey}
                    value={config.api_key}
                    onChange={(v) => set({ api_key: v })}
                    secure
                  />
                  <TextRow
                    label={t.aiModel}
                    value={config.model}
                    onChange={(v) => set({ model: v })}
                    placeholder="gemini-2.5-flash"
                  />
                  <NumberRow
                    label={t.aiFrames}
                    value={config.frames_per_recording}
                    onChange={(v) => set({ frames_per_recording: v })}
                  />
                  <NumberRow
                    label={t.aiTimeout}
                    suffix={t.unitSecond}
                    value={config.timeout_seconds}
                    onChange={(v) => set({ timeout_seconds: v })}
                  />
                  <NumberRow
                    label={t.aiReplyLength}
                    value={config.max_output_tokens}
                    onChange={(v) => set({ max_output_tokens: v })}
                    last
                  />
                </InfoCard>

                <InfoCard title={t.aiWhatToCheck}>
                  {checks.length === 0 ? (
                    <Text style={[styles.hint, rtlText]}>{t.aiNoChecks}</Text>
                  ) : null}
                  {checks.map((check, index) => (
                    <CheckEditor
                      key={check.id}
                      check={check}
                      last={index === checks.length - 1}
                      disabled={saving}
                      onPatch={(values) =>
                        run(() => writeAiCheck(connection.baseUrl, check.id, values))
                      }
                      onRemove={() => removeCheck(check)}
                    />
                  ))}
                </InfoCard>

                <PrimaryButton
                  label={t.aiAddCheck}
                  icon="add"
                  variant="ghost"
                  onPress={addCheck}
                  disabled={saving}
                />

                <InfoCard title={t.aiExtraInstructions}>
                  <TextRow
                    label={t.aiExtraInstructions}
                    value={config.extra_instructions}
                    onChange={(v) => set({ extra_instructions: v })}
                    multiline
                    last
                  />
                </InfoCard>
              </>
            ) : null}

            <PrimaryButton label={t.save} icon="save-outline" onPress={save} loading={saving} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** One thing the AI is asked to look for. */
function CheckEditor({ check, onPatch, onRemove, disabled, last }) {
  const { t, rtlRow, rtlText } = useT();
  const [name, setName] = useState(check.name || '');
  const [description, setDescription] = useState(check.description || '');
  const dirty = name !== (check.name || '') || description !== (check.description || '');

  return (
    <View style={[styles.check, last && styles.checkLast]}>
      <View style={[styles.checkHead, rtlRow]}>
        <Text style={[styles.checkTitle, rtlText]} numberOfLines={1}>
          {check.name}
        </Text>
        <Pressable
          onPress={onRemove}
          hitSlop={10}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t.delete}
        >
          <Ionicons name="trash-outline" size={17} color={colors.danger} />
        </Pressable>
      </View>

      <TextRow label={t.checkName} value={name} onChange={setName} />
      <TextRow
        label={t.checkDescription}
        value={description}
        onChange={setDescription}
        multiline
      />
      <ToggleRow
        label={t.active}
        value={check.active}
        onChange={(v) => onPatch({ active: v })}
        last={!dirty}
      />
      {dirty ? (
        <PrimaryButton
          label={t.save}
          variant="ghost"
          onPress={() => onPatch({ name, description })}
          style={styles.inlineSave}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flex: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: 20, fontWeight: '700', color: colors.white, letterSpacing: -0.3 },

  body: { padding: spacing.xl, gap: spacing.md },
  spinner: { marginTop: spacing.xxxl },
  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.title },
  hint: { ...typography.caption, paddingVertical: spacing.lg },

  check: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: spacing.sm },
  checkLast: { borderBottomWidth: 0 },
  checkHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.lg,
  },
  checkTitle: { flex: 1, fontSize: 14, fontWeight: '800', color: colors.text },
  inlineSave: { marginBottom: spacing.md },
});
