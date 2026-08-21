import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getItem, setItem } from '../utils/deviceStore';
import { dictionaries } from './translations';

const LANGUAGE_KEY = 'showroomcheck.language';
const DEFAULT_LANGUAGE = 'en';

/**
 * Interface language, and the direction that goes with it.
 *
 * `I18nManager.forceRTL` is deliberately NOT used. It flips layout for the whole
 * process, persists across launches, and only takes effect after a full restart
 * -- so tapping "عربي" would appear to do nothing until the user killed the app.
 * Instead `isRTL` is exposed with two ready-made style objects, and screens
 * apply them where direction actually matters. The switch is then instant.
 */
const LanguageContext = createContext(null);

const RTL_TEXT = { textAlign: 'right', writingDirection: 'rtl' };
const RTL_ROW = { flexDirection: 'row-reverse' };
const EMPTY = {};

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(DEFAULT_LANGUAGE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await getItem(LANGUAGE_KEY);
      if (!cancelled && (saved === 'en' || saved === 'ar')) setLangState(saved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLang = useCallback((next) => {
    if (next !== 'en' && next !== 'ar') return;
    // Applied immediately; the write is only about surviving a restart, so it
    // must not hold the interface up or break the switch when it fails.
    setLangState(next);
    void setItem(LANGUAGE_KEY, next).catch(() => {});
  }, []);

  const value = useMemo(() => {
    const isRTL = lang === 'ar';
    return {
      t: dictionaries[lang] ?? dictionaries.en,
      lang,
      isRTL,
      setLang,
      rtlText: isRTL ? RTL_TEXT : EMPTY,
      rtlRow: isRTL ? RTL_ROW : EMPTY,
    };
  }, [lang, setLang]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useT must be used inside <LanguageProvider>');
  return ctx;
}

/**
 * Pick the message to show for an AppError.
 *
 * An error carrying its own wording keeps it: that is almost always the
 * server's explanation ("this round has already been recorded"), which is far
 * more useful than the generic line for its kind -- and is not ours to
 * translate anyway, since it arrives in the server account's language. Only the
 * generic kinds come from the dictionary.
 */
export function translateError(t, error) {
  if (error?.hasOwnMessage && error.message) return error.message;
  return t.errors?.[error?.kind] ?? error?.message ?? t.errors.server;
}
