import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { AppError } from '../../src/api/errors';
import { fetchGuide } from '../../src/api/manual';
import { useAuth } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { GradientBackground, GradientOrbs } from '../../src/components/GradientBackground';
import { translateError, useT } from '../../src/i18n/LanguageProvider';
import { colors, radius, spacing, typography } from '../../src/theme';
import { log } from '../../src/utils/log';
import { openManualPdf } from '../../src/utils/openManual';

/**
 * Wrap the guide body in a page the phone can read.
 *
 * The server sends the body alone, so this is where the type sizes, the
 * margins and the button live. Written as a template rather than assembled
 * from state so the WebView is handed one finished string and never reloads
 * mid-read.
 *
 * The button posts a message rather than opening a URL: a WebView carries no
 * session, and the app already knows how to fetch a document properly.
 */
const page = ({ html, hasPdf, pdfLabel, emptyLabel, rtl }) => `<!DOCTYPE html>
<html lang="en" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 20px 18px 32px;
    font-family: -apple-system, Roboto, 'Segoe UI', sans-serif;
    font-size: 16px; line-height: 1.65; color: #0F172A; background: #FFFFFF;
    -webkit-text-size-adjust: 100%;
  }
  h1 { font-size: 22px; } h2 { font-size: 19px; } h3 { font-size: 17px; }
  h1, h2, h3 { line-height: 1.3; margin: 1.4em 0 0.5em; }
  h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
  p, li { font-size: 16px; }
  ul, ol { padding-${rtl ? 'right' : 'left'}: 22px; }
  /* Anything pasted in from a word processor still has to fit a phone. */
  img, video, iframe { max-width: 100%; height: auto; }
  table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
  th, td { border: 1px solid #E2E8F0; padding: 8px; text-align: ${rtl ? 'right' : 'left'}; }
  pre { overflow-x: auto; background: #F8FAFC; padding: 12px; border-radius: 8px; }
  a { color: #4F46E5; }
  .sc-empty { color: #64748B; font-style: italic; }
  .sc-pdf {
    display: block; width: 100%; margin-top: 28px; padding: 15px 18px;
    background: #4F46E5; color: #fff; border: 0; border-radius: 12px;
    font-size: 16px; font-weight: 600; font-family: inherit; cursor: pointer;
  }
  .sc-pdf:active { opacity: 0.75; }
</style>
</head>
<body>
${html || `<p class="sc-empty">${emptyLabel}</p>`}
${
  hasPdf
    ? `<button class="sc-pdf" onclick="window.ReactNativeWebView.postMessage('open-pdf')">
         📄 ${pdfLabel}
       </button>`
    : ''
}
</body>
</html>`;

/**
 * One guide, read on the phone.
 *
 * Reached from a document on the Help shelf. The guide is what most people
 * came for; the PDF behind it is for whoever wants the whole thing, and opens
 * through the same path the shelf itself uses.
 */
export default function GuideRoute() {
  return (
    <RequireAuth>
      <GuideScreen />
    </RequireAuth>
  );
}

function GuideScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const { connection } = useAuth();
  const { t, rtlRow, rtlText, isRTL } = useT();

  const [guide, setGuide] = useState(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!connection) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchGuide(connection.baseUrl, Number(id));
        if (!cancelled) setGuide(result || null);
      } catch (e) {
        if (!cancelled) setError(translateError(t, AppError.from(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The guide is fetched for the id this screen was opened with; `t` only
    // affects the wording of a failure, and re-fetching to restyle one would
    // throw away the page being read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, id]);

  const openPdf = useCallback(async () => {
    setError(null);
    setOpening(true);
    try {
      await openManualPdf(connection.baseUrl, Number(id));
    } catch (e) {
      // Said out loud, unlike a shelf that comes back empty: they pressed the
      // button, so they are owed a reason it did not open.
      setError(translateError(t, AppError.from(e)));
    } finally {
      setOpening(false);
    }
  }, [connection, id, t]);

  useEffect(() => {
    log('manual', 'guide opened', { id, hasPdf: !!guide?.has_pdf });
  }, [id, guide]);

  return (
    <View style={styles.screen}>
      <GradientBackground soft style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <GradientOrbs />
        <View style={[styles.headerRow, rtlRow]}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Ionicons name={isRTL ? 'chevron-forward' : 'chevron-back'} size={22} color={colors.white} />
          </Pressable>
          <Text style={[styles.title, rtlText]} numberOfLines={1}>
            {guide?.name ?? t.userManual}
          </Text>
          {opening ? <ActivityIndicator color={colors.white} /> : null}
        </View>
      </GradientBackground>

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <View style={styles.centre}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <WebView
          originWhitelist={['*']}
          source={{
            html: page({
              html: guide?.html ?? '',
              hasPdf: !!guide?.has_pdf,
              pdfLabel: t.openFullPdf,
              emptyLabel: t.guideNotWritten,
              rtl: isRTL,
            }),
          }}
          onMessage={(event) => {
            if (event.nativeEvent.data === 'open-pdf') void openPdf();
          }}
          // The guide is text: nothing in it should be able to navigate away,
          // and the only way out is the button, which posts a message instead.
          onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
          style={styles.web}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    // GradientBackground defaults to flex:1, which here would make this header
    // eat the whole screen. Same note as on the Missed and History headers.
    flex: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { ...typography.title, color: colors.white, letterSpacing: -0.4, flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  web: { flex: 1, backgroundColor: colors.surface },
});
