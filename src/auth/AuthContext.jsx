import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppError } from '../api/errors';
import { getSessionCookie, setSessionCookie } from '../api/rpcClient';
import { authenticate, destroySession, fetchUserRecord, getSessionInfo } from '../api/backend';
import {
  clearAll,
  loadPassword,
  loadSession,
  savePassword,
  saveRememberedServer,
  saveSession,
} from './storage';
/** The backend returns `false` for empty values, so normalise before display. */
const text = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
/** Many2one fields arrive as `[id, "Display Name"]`. */
const relationName = (value) =>
  Array.isArray(value) && typeof value[1] === 'string' ? value[1] : undefined;
const AuthContext = createContext(null);
function buildUser(session, record) {
  return {
    uid: session.uid,
    name: text(record?.name) ?? text(session.name) ?? text(session.username) ?? 'User',
    login: text(record?.login) ?? text(session.username) ?? '',
    email: text(record?.email),
    phone: text(record?.phone),
    mobile: text(record?.mobile),
    jobTitle: text(record?.function),
    companyName: relationName(record?.company_id),
    partnerName: relationName(record?.partner_id) ?? text(session.partner_display_name),
    timezone: text(record?.tz) ?? text(session.user_context?.tz),
    language: text(record?.lang) ?? text(session.user_context?.lang),
    lastLogin: text(record?.login_date),
    isAdmin: Boolean(session.is_admin ?? session.is_system),
    avatarBase64: text(record?.image_128),
  };
}
export function AuthProvider({ children }) {
  const [status, setStatus] = useState('restoring');
  const [user, setUser] = useState(null);
  const [connection, setConnection] = useState(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const applySession = useCallback(async (baseUrl, session, password) => {
    const record = await fetchUserRecord(baseUrl, session.uid, session.user_context ?? {});
    const nextConnection = {
      baseUrl,
      db: session.db,
      serverVersion: text(session.server_version),
    };
    await saveSession({
      baseUrl,
      db: session.db,
      login: text(session.username) ?? text(record?.login) ?? '',
      uid: session.uid,
      name: text(session.name),
      serverVersion: nextConnection.serverVersion,
      sessionCookie: getSessionCookie(),
    });
    if (password) await savePassword(password);
    // Survives sign-out so the login screen comes back pre-filled.
    await saveRememberedServer({ baseUrl, db: session.db });
    if (!mounted.current) return;
    setConnection(nextConnection);
    setUser(buildUser(session, record));
    setStatus('authenticated');
  }, []);
  /**
   * Boot path: reuse the stored cookie if the server still honours it, otherwise
   * silently re-authenticate with the stored password. Only if both fail does
   * the user see the login screen again.
   */
  const restore = useCallback(async () => {
    try {
      const stored = await loadSession();
      if (!stored) {
        if (mounted.current) setStatus('unauthenticated');
        return;
      }
      setSessionCookie(stored.sessionCookie ?? null);
      const live = await getSessionInfo(stored.baseUrl).catch(() => null);
      if (live?.uid) {
        await applySession(stored.baseUrl, live);
        return;
      }
      const password = await loadPassword();
      if (password) {
        const session = await authenticate(stored.baseUrl, stored.db, stored.login, password);
        await applySession(stored.baseUrl, session, password);
        return;
      }
      if (mounted.current) setStatus('unauthenticated');
    } catch {
      // Offline or credentials no longer valid -- fall back to the login screen.
      setSessionCookie(null);
      if (mounted.current) setStatus('unauthenticated');
    }
  }, [applySession]);
  useEffect(() => {
    void restore();
  }, [restore]);
  const signIn = useCallback(
    async ({ baseUrl, db, login, password }) => {
      const session = await authenticate(baseUrl, db, login, password);
      await applySession(baseUrl, session, password);
    },
    [applySession],
  );
  const signOut = useCallback(async () => {
    const baseUrl = connection?.baseUrl;
    if (baseUrl) await destroySession(baseUrl);
    setSessionCookie(null);
    await clearAll();
    if (!mounted.current) return;
    setUser(null);
    setConnection(null);
    setStatus('unauthenticated');
  }, [connection]);
  const refreshProfile = useCallback(async () => {
    if (!connection || !user) return;
    const live = await getSessionInfo(connection.baseUrl);
    if (!live?.uid) throw new AppError('session_expired');
    const record = await fetchUserRecord(connection.baseUrl, live.uid, live.user_context ?? {});
    if (mounted.current) setUser(buildUser(live, record));
  }, [connection, user]);
  const value = useMemo(
    () => ({ status, user, connection, signIn, signOut, refreshProfile }),
    [status, user, connection, signIn, signOut, refreshProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
