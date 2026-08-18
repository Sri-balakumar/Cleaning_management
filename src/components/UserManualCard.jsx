import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
// The SDK 54 File API's write() takes a string or a Uint8Array, so putting
// base64 through it means decoding by hand - and getting that wrong writes a
// text file with a .pdf name. The legacy helper does exactly this one job.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { AppError } from '../api/errors';
import { fetchManual, fetchManuals } from '../api/manual';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from './ErrorBanner';
import { InfoCard } from './InfoRow';
import { translateError, useT } from '../i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../theme';
import { log } from '../utils/log';

/** Keep a filename usable as a filename, whatever was typed in the backend. */
const safeName = (name) => String(name || 'manual.pdf').replace(/[^\w.\- ]+/g, '_');

/**
 * The manual PDFs, listed straight from the server.
 *
 * Renders nothing at all when there are none, or when the call fails - the
 * module holding these is optional, and a screen should not sprout an error
 * because something optional is absent. A failure *after* someone taps is
 * different: they asked for it, so they get told.
 */
export function UserManualCard() {
  const { connection } = useAuth();
  const { t, rtlRow, rtlText } = useT();

  const [manuals, setManuals] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!connection) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchManuals(connection.baseUrl);
        if (!cancelled) setManuals(Array.isArray(rows) ? rows : []);
      } catch (e) {
        // Almost always "the module is not installed". Nothing to say.
        log('manual', 'list unavailable', AppError.from(e).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const open = useCallback(
    async (manual) => {
      setError(null);
      setBusyId(manual.id);
      try {
        const doc = await fetchManual(connection.baseUrl, manual.id);
        if (!doc?.data) throw new AppError('server');

        // Handing the browser a URL is not an option: it has no session cookie,
        // so the server would refuse. Fetch the bytes, then let the system
        // chooser pass the file to a real PDF viewer.
        const uri = `${FileSystem.cacheDirectory}${safeName(doc.filename)}`;
        await FileSystem.writeAsStringAsync(uri, doc.data, { encoding: 'base64' });

        if (!(await Sharing.isAvailableAsync())) throw new AppError('server');
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          UTI: 'com.adobe.pdf',
          dialogTitle: doc.name,
        });
        log('manual', 'opened', { id: manual.id, filename: doc.filename });
      } catch (e) {
        setError(translateError(t, AppError.from(e)));
      } finally {
        setBusyId(null);
      }
    },
    [connection, t],
  );

  if (!manuals.length) return null;

  return (
    <InfoCard title={t.userManual}>
      {error ? <ErrorBanner message={error} /> : null}

      {manuals.map((manual, index) => (
        <Pressable
          key={manual.id}
          onPress={() => void open(manual)}
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
          <Text style={[styles.name, rtlText]} numberOfLines={2}>
            {manual.name}
          </Text>
          {busyId === manual.id ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Ionicons name="open-outline" size={18} color={colors.textMuted} />
          )}
        </Pressable>
      ))}
    </InfoCard>
  );
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
  icon: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  name: { ...typography.body, flex: 1 },
});
