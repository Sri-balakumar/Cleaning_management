import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppError } from '../../src/api/errors';
import {
  fetchConfig,
  fetchReferenceImages,
  readUserNames,
  searchUsers,
  writeConfig,
  writeReferenceImage,
} from '../../src/api/config';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { InfoCard } from '../../src/components/InfoRow';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { SectionTabs } from '../../src/components/SectionTabs';
import {
  NumberRow,
  OptionSheet,
  SelectRow,
  TextRow,
  ToggleRow,
} from '../../src/components/SettingRows';
import { ShowroomViews } from '../../src/components/ShowroomViews';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';

/**
 * Exactly what a save writes, built from the record on screen.
 *
 * Its own function because two things need it and they must not drift: the save
 * itself, and the check for whether anything has changed since it was loaded.
 */
function configPayload(config) {
  return {
    timezone: config.timezone,
    video_enabled: !!config.video_enabled,
    duration_value: Number(config.duration_value) || 0,
    duration_unit: config.duration_unit,
    video_format: config.video_format,
    video_quality: config.video_quality,
    camera_facing: config.camera_facing,
    max_upload_mb: Number(config.max_upload_mb) || 0,
    allowed_user_mode: config.allowed_user_mode,
    allowed_user_ids: [[6, 0, config.allowed_user_ids || []]],
    upload_grace_seconds: Number(config.upload_grace_seconds) || 0,
    retention_number: Number(config.retention_number) || 0,
    retention_unit: config.retention_unit,
    retention_mode: config.retention_mode,
    require_photos: !!config.require_photos,
    match_warn_threshold: Number(config.match_warn_threshold) || 0,
    match_alert_threshold: Number(config.match_alert_threshold) || 0,
    notify_low_match: !!config.notify_low_match,
    notify_threshold: Number(config.notify_threshold) || 0,
  };
}

export default function SettingsRoute() {
  return (
    <RequireAuth>
      <SettingsScreen />
    </RequireAuth>
  );
}

function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [config, setConfig] = useState(null);
  // What was loaded, kept so "has anything changed?" has something to ask.
  const [baseline, setBaseline] = useState(null);
  const [views, setViews] = useState([]);
  const [userNames, setUserNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [tzOpen, setTzOpen] = useState(false);
  // Which section is on screen. The keys are the web notebook's own page names,
  // so the two stay recognisably the same form.
  const [tab, setTab] = useState('schedule');

  const load = useCallback(async () => {
    setError(null);
    try {
      const cfg = await fetchConfig(connection.baseUrl);
      setConfig(cfg);
      setBaseline(cfg);
      if (cfg) {
        const [users, originals] = await Promise.all([
          readUserNames(connection.baseUrl, cfg.allowed_user_ids || []),
          fetchReferenceImages(connection.baseUrl, cfg.id),
        ]);
        setUserNames(Object.fromEntries((users || []).map((u) => [u.id, u.name])));
        setViews(originals || []);
      }
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

  /** Every write goes through here so one place reports the server's refusal. */
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
        // The server's own wording: overlapping windows, a round with no
        // weekday, a duration past the cap. Far better than anything generic.
        setError(translateError(t, AppError.from(e)));
      } finally {
        setSaving(false);
      }
    },
    [load, t],
  );

  const saveConfig = () =>
    run(() => writeConfig(connection.baseUrl, config.id, configPayload(config)));

  /**
   * Is there anything to save?
   *
   * Compared through configPayload, the same function the save itself is built
   * from, so the two can never disagree about which fields count. Comparing a
   * hand-written list of fields instead would eventually leave Save faded over
   * a real unsaved change the day somebody adds a setting and updates only one
   * of the two lists - a worse bug than the one being fixed.
   */
  const dirty = useMemo(() => {
    if (!config || !baseline) return false;
    return JSON.stringify(configPayload(config)) !== JSON.stringify(configPayload(baseline));
  }, [baseline, config]);

  const patchView = (id, values) => run(() => writeReferenceImage(connection.baseUrl, id, values));

  // In here rather than at module scope so the labels follow the language.
  const tabs = useMemo(
    () => [
      { key: 'schedule', label: t.sectionDailyRounds },
      { key: 'reference', label: t.sectionShowroomViews },
      { key: 'recording', label: t.sectionRecording },
      { key: 'access', label: t.sectionWhoCanRecord },
      { key: 'retention', label: t.sectionKeeping },
    ],
    [t],
  );

  const options = useMemo(
    () => ({
      durationUnit: [
        { value: 'seconds', label: t.unitSeconds },
        { value: 'minutes', label: t.unitMinutes },
        { value: 'hours', label: t.unitHours },
      ],
      quality: [
        { value: 'low', label: t.qualityLow },
        { value: 'medium', label: t.qualityMedium },
        { value: 'high', label: t.qualityHigh },
      ],
      format: [
        { value: 'webm', label: 'WebM' },
        { value: 'mp4', label: 'MP4' },
      ],
      facing: [
        { value: 'environment', label: t.cameraRear },
        { value: 'user', label: t.cameraFront },
      ],
      allowedMode: [
        { value: 'all', label: t.everyone },
        { value: 'list', label: t.namedList },
      ],
      retentionUnit: [
        { value: 'days', label: t.unitDays },
        { value: 'weeks', label: t.unitWeeks },
        { value: 'months', label: t.unitMonths },
      ],
      retentionMode: [
        { value: 'video', label: t.retentionVideoOnly },
        { value: 'record', label: t.retentionWholeRecord },
      ],
    }),
    [t],
  );

  // Offered as a searchable sheet rather than the full tz list, which is long.
  const timezoneOptions = useMemo(() => {
    const common = [
      'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Europe/London',
      'Europe/Lisbon', 'Europe/Paris', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'Australia/Sydney',
    ];
    const all = config?.timezone && !common.includes(config.timezone)
      ? [config.timezone, ...common]
      : common;
    return all.map((z) => ({ value: z, label: z }));
  }, [config?.timezone]);

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]}>{t.settings}</Text>
        </View>
      </GradientBackground>

      {/* Outside the ScrollView, so the strip stays put while a section scrolls
          under it - which is how the notebook tabs behave on the web. */}
      {config ? <SectionTabs tabs={tabs} value={tab} onChange={setTab} /> : null}

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
            <Text style={styles.emptyIcon}>🧹</Text>
            <Text style={styles.emptyTitle}>{t.nothingSetUp}</Text>
          </View>
        ) : null}

        {config ? (
          <>
            {tab === 'schedule' ? (
            <>
            <InfoCard title={t.sectionDailyRounds}>
              <SelectRow
                label={t.officeTimezone}
                hint={t.timezoneHint}
                value={config.timezone}
                options={timezoneOptions}
                onChange={(v) => {
                  set({ timezone: v });
                  void run(() => writeConfig(connection.baseUrl, config.id, { timezone: v }));
                }}
                last
              />
            </InfoCard>

            {/* The rounds themselves are a screen of their own, the way the
                web keeps them. A way through to it, not a second editor.

                Filled rather than ghost: a ghost button is a white face on the
                grey body, directly under a white card, and reads as more of
                the card rather than as the one thing on this tab to press. */}
            <PrimaryButton
              label={t.configRounds}
              icon="time-outline"
              onPress={() => router.push('/settings/rounds')}
              style={styles.addBtn}
            />
            </>
            ) : null}

            {tab === 'reference' ? (
            <InfoCard title={t.sectionShowroomViews}>
              <ShowroomViews
                baseUrl={connection.baseUrl}
                views={views}
                disabled={saving}
                onWrite={patchView}
              />
              <ToggleRow
                label={t.requirePhotos}
                hint={t.requirePhotosHint}
                value={config.require_photos}
                onChange={(v) => set({ require_photos: v })}
              />
              <NumberRow
                label={t.warnBelow}
                value={config.match_warn_threshold}
                onChange={(v) => set({ match_warn_threshold: v })}
              />
              <NumberRow
                label={t.alertBelow}
                hint={t.thresholdsHint}
                value={config.match_alert_threshold}
                onChange={(v) => set({ match_alert_threshold: v })}
              />
              {/* Kept beside the two warning levels rather than given a section
                  of its own, because the three numbers are read together: what
                  turns a badge amber, what turns it red, and what is worth
                  interrupting somebody over. The server form groups them the
                  same way, under Settings > Showroom Photos. */}
              <ToggleRow
                label={t.notifyLowMatch}
                hint={t.notifyLowMatchHint}
                value={config.notify_low_match}
                onChange={(v) => set({ notify_low_match: v })}
                last={!config.notify_low_match}
              />
              {/* Put away when the toggle is off: a level that decides nothing
                  should not sit there inviting somebody to tune it. */}
              {config.notify_low_match ? (
                <NumberRow
                  label={t.notifyBelow}
                  hint={t.notifyBelowHint}
                  value={config.notify_threshold}
                  onChange={(v) => set({ notify_threshold: v })}
                  last
                />
              ) : null}
            </InfoCard>
            ) : null}

            {tab === 'recording' ? (
            <InfoCard title={t.sectionRecording}>
              <ToggleRow
                label={t.videoEnabled}
                hint={t.videoEnabledHint}
                value={config.video_enabled}
                onChange={(v) => set({ video_enabled: v })}
                last={!config.video_enabled}
              />
              {/* Everything below describes the video. With it off they are not
                  in use, so they are put away rather than left sitting there
                  inviting somebody to tune a clip that is never recorded. */}
              {!config.video_enabled ? (
                <Text style={[styles.hint, rtlText, styles.videoOff]}>{t.videoOffNote}</Text>
              ) : (
                <>
              <NumberRow
                label={t.clipLength}
                value={config.duration_value}
                onChange={(v) => set({ duration_value: v })}
              />
              <SelectRow
                label={t.durationUnit}
                value={config.duration_unit}
                options={options.durationUnit}
                onChange={(v) => set({ duration_unit: v })}
              />
              <SelectRow
                label={t.qualityLabel}
                value={config.video_quality}
                options={options.quality}
                onChange={(v) => set({ video_quality: v })}
              />
              <SelectRow
                label={t.format}
                value={config.video_format}
                options={options.format}
                onChange={(v) => set({ video_format: v })}
              />
              <SelectRow
                label={t.cameraSide}
                value={config.camera_facing}
                options={options.facing}
                onChange={(v) => set({ camera_facing: v })}
              />
              <NumberRow
                label={t.maxUpload}
                suffix="MB"
                value={config.max_upload_mb}
                onChange={(v) => set({ max_upload_mb: v })}
              />
              <View style={[styles.readonly, rtlRow]}>
                <Text style={[styles.hint, rtlText]}>{t.estimatedSize}</Text>
                <Text style={styles.readonlyValue}>
                  ~{Number(config.estimated_size_mb || 0).toFixed(1)} MB
                </Text>
              </View>
                </>
              )}
            </InfoCard>
            ) : null}

            {tab === 'access' ? (
            <InfoCard title={t.sectionWhoCanRecord}>
              <SelectRow
                label={t.whoMode}
                value={config.allowed_user_mode}
                options={options.allowedMode}
                onChange={(v) => set({ allowed_user_mode: v })}
              />
              {config.allowed_user_mode === 'list' ? (
                <UserPicker
                  baseUrl={connection.baseUrl}
                  ids={config.allowed_user_ids || []}
                  names={userNames}
                  onChange={(ids, names) => {
                    set({ allowed_user_ids: ids });
                    setUserNames((prev) => ({ ...prev, ...names }));
                  }}
                />
              ) : null}
              <NumberRow
                label={t.gracePeriod}
                suffix={t.unitSecond}
                value={config.upload_grace_seconds}
                onChange={(v) => set({ upload_grace_seconds: v })}
                last
              />
            </InfoCard>
            ) : null}

            {tab === 'retention' ? (
            <InfoCard title={t.sectionKeeping}>
              <NumberRow
                label={t.keepFor}
                value={config.retention_number}
                onChange={(v) => set({ retention_number: v })}
              />
              <SelectRow
                label={t.retentionUnit}
                value={config.retention_unit}
                options={options.retentionUnit}
                onChange={(v) => set({ retention_unit: v })}
              />
              <SelectRow
                label={t.thenWhat}
                value={config.retention_mode}
                options={options.retentionMode}
                onChange={(v) => set({ retention_mode: v })}
                last
              />
            </InfoCard>
            ) : null}

            {/* Daily rounds has nothing left to save -- the timezone writes
                itself and the rounds are a screen of their own -- so the button
                is not shown there. It still appears if something typed on
                another tab is unsaved, because saveConfig writes the whole
                record from `config`, which holds the fields of the tabs that
                are not on screen just as much as the one that is; hiding it
                over an unsaved change would strand it. */}
            {tab === 'schedule' && !dirty ? null : (
              <PrimaryButton
                label={t.save}
                icon="save-outline"
                onPress={saveConfig}
                loading={saving}
                disabled={!dirty}
              />
            )}
          </>
        ) : null}
      </ScrollView>

      <OptionSheet
        visible={tzOpen}
        title={t.officeTimezone}
        options={timezoneOptions}
        selected={config?.timezone}
        onSelect={(v) => {
          set({ timezone: v });
          setTzOpen(false);
        }}
        onClose={() => setTzOpen(false)}
      />
    </View>
  );
}

/** Searchable list of who may record, when the mode is a named list. */
function UserPicker({ baseUrl, ids, names, onChange }) {
  const { t, rtlRow, rtlText } = useT();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const rows = await searchUsers(baseUrl, term);
      setResults(rows || []);
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, [baseUrl, term]);

  const toggle = (id, label) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    onChange(next, { [id]: label });
  };

  return (
    <View style={styles.stack}>
      <Text style={[styles.label, rtlText]}>{t.allowedUsers}</Text>

      <View style={[styles.chips, rtlRow]}>
        {ids.length === 0 ? <Text style={styles.hint}>{t.noneSelected}</Text> : null}
        {ids.map((id) => (
          <Pressable key={id} onPress={() => toggle(id, names[id])} style={[styles.chip, rtlRow]}>
            <Text style={styles.chipText}>{names[id] ?? id}</Text>
            <Ionicons name="close" size={13} color={colors.primary} />
          </Pressable>
        ))}
      </View>

      <TextRow
        label={t.searchUsers}
        value={term}
        onChange={setTerm}
        placeholder={t.searchUsers}
        last
      />
      <PrimaryButton
        label={t.search}
        variant="ghost"
        onPress={search}
        loading={busy}
        style={styles.inlineSave}
      />

      {results.map(([id, label]) => (
        <Pressable key={id} onPress={() => toggle(id, label)} style={[styles.result, rtlRow]}>
          <Ionicons
            name={ids.includes(id) ? 'checkbox' : 'square-outline'}
            size={18}
            color={ids.includes(id) ? colors.primary : colors.textMuted}
          />
          <Text style={[styles.resultText, rtlText]}>{label}</Text>
        </Pressable>
      ))}
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
  videoOff: { paddingBottom: spacing.lg, lineHeight: 18 },
  spinner: { marginTop: spacing.xxxl },
  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.title },

  inlineSave: { marginBottom: spacing.md },
  addBtn: { marginBottom: spacing.md },
  label: { ...typography.label },
  hint: { ...typography.caption, fontSize: 11 },
  stack: { paddingVertical: spacing.lg, gap: spacing.sm },
  readonly: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
  },
  readonlyValue: { fontSize: 14, fontWeight: '700', color: colors.text },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#EEF2FF',
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
  },
  chipText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  result: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  resultText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
});
