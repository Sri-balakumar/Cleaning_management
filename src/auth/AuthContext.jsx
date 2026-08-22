import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getDashboardState } from '../api/cleaning';
import { registerForPush, unregisterFromPush } from '../push/registerDevice';
import { AppError } from '../api/errors';
import { getSessionCookie, setSessionCookie } from '../api/rpcClient';
import { authenticate, destroySession, fetchUserRecord, getSessionInfo } from '../api/backend';
import {
  clearAll,
  clearRememberedServer,
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
/**
 * Refuse a database that does not carry the module.
 *
 * A password is accepted by whichever database was picked at the bottom of the
 * login screen, so a perfectly correct sign-in can still land somewhere this app
 * has nothing to talk to -- and every screen then fails one call at a time. The
 * dashboard call is the cheapest way to ask the question, because a model the
 * database has never heard of is exactly what comes back as `module_missing`.
 *
 * Only that one answer refuses. A slow link or a dropped connection must never
 * stand between someone and their session -- the screens report those on their
 * own -- so anything else is left to them.
 */
async function assertModuleInstalled(baseUrl) {
  try {
    // The answer is kept rather than thrown away: it carries whether this
    // person manages the rounds, which decides what the tab bar offers. Asking
    // a second time for one boolean already in hand would be a wasted call.
    return await getDashboardState(baseUrl);
  } catch (error) {
    const err = AppError.from(error);
    if (err.kind !== 'module_missing') return null;
    // Dropped here rather than left for the caller: this throws before anything
    // is saved, so the cookie is the only trace a refused sign-in would leave.
    setSessionCookie(null);
    throw err;
  }
}

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('restoring');
  const [user, setUser] = useState(null);
  const [connection, setConnection] = useState(null);
  // The address this phone is reachable at, kept only so sign-out can hand it
  // back. Nothing reads it for anything else, and it deliberately does not
  // live in state: changing it must not re-render the whole app.
  const pushToken = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const applySession = useCallback(async (baseUrl, session, password) => {
    const dashboard = await assertModuleInstalled(baseUrl);
    const record = await fetchUserRecord(baseUrl, session.uid, session.user_context ?? {});
    const nextConnection = {
      baseUrl,
      db: session.db,
      serverVersion: text(session.server_version),
      // Whether this person runs the rounds or walks them. Answered by the
      // server, from the call above -- being an administrator and being a
      // cleaning manager are separate things, so asking is the only way to
      // know. False where the answer never arrived, which shows the smaller
      // set of tabs rather than offering screens that would come back empty.
      isManager: Boolean(dashboard?.is_manager),
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

    // Deliberately NOT awaited. Registering talks to Android and then to the
    // server, and neither is worth making somebody wait at a sign-in button
    // for -- least of all when the answer may be "this phone cannot be
    // notified", which changes nothing about whether they can use the app.
    // Runs on restore as well as sign-in, which is what keeps the token
    // current: Firebase rotates them, and a stale one silently stops arriving.
    registerForPush({ baseUrl, isManager: nextConnection.isManager })
      .then((token) => {
        pushToken.current = token;
      })
      .catch(() => {});
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
  /**
   * Sign out. Always clears the session and the stored password.
   *
   * `forgetServer` additionally drops the remembered address. Without it the
   * login screen refills the previous address and immediately probes it, so
   * moving to a different server means clearing that field by hand first.
   */
  const signOut = useCallback(
    async ({ forgetServer = false } = {}) => {
      const baseUrl = connection?.baseUrl;
      // BEFORE destroySession, while the call is still authenticated. After it
      // the server would refuse this, and the phone would go on being sent
      // every low round until Firebase happened to report the token dead.
      if (baseUrl && pushToken.current) {
        await unregisterFromPush({ baseUrl, token: pushToken.current });
        pushToken.current = null;
      }
      if (baseUrl) await destroySession(baseUrl);
      setSessionCookie(null);
      await clearAll();
      if (forgetServer) await clearRememberedServer();
      if (!mounted.current) return;
      setUser(null);
      setConnection(null);
      setStatus('unauthenticated');
    },
    [connection],
  );
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
