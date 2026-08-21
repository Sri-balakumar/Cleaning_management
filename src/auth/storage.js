import { getItem, removeItem, setItem } from '../utils/deviceStore';
/**
 * What this app remembers about the signed-in session.
 *
 * Only small scalars are persisted -- notably the base64 avatar is NEVER stored
 * here, it would blow the platform's value-size limit on its own. It lives in
 * memory for the session instead.
 */
const MAX_SECURE_VALUE_BYTES = 1800;
const SESSION_KEY = 'showroomcheck.session';
const PASSWORD_KEY = 'showroomcheck.password';
const LAST_SERVER_KEY = 'showroomcheck.lastServer';
export async function saveSession(session) {
  const payload = JSON.stringify(session);
  if (payload.length > MAX_SECURE_VALUE_BYTES) {
    // Should be impossible with scalars only; guard so a future field addition
    // fails loudly in dev rather than silently on iOS devices.
    if (__DEV__) {
      console.warn(
        `[storage] session payload is ${payload.length}B, over the ${MAX_SECURE_VALUE_BYTES}B budget. ` +
          'Do not persist large values (e.g. avatars) in SecureStore.',
      );
    }
  }
  await setItem(SESSION_KEY, payload);
}
export async function loadSession() {
  const raw = await getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.baseUrl && parsed?.db && parsed?.login ? parsed : null;
  } catch {
    return null;
  }
}
export const savePassword = (password) => setItem(PASSWORD_KEY, password);
export const loadPassword = () => getItem(PASSWORD_KEY);
/**
 * Server coordinates kept across sign-out so a returning user does not have to
 * retype the address. Deliberately holds no credentials.
 *
 * @typedef {{ baseUrl: string, db: string }} RememberedServer
 */
export const saveRememberedServer = (server) => setItem(LAST_SERVER_KEY, JSON.stringify(server));
export async function loadRememberedServer() {
  const raw = await getItem(LAST_SERVER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.baseUrl ? parsed : null;
  } catch {
    return null;
  }
}
export const clearRememberedServer = () => removeItem(LAST_SERVER_KEY);
/**
 * Sign-out cleanup. Drops the session and the password, but deliberately keeps
 * the remembered server so the login screen returns pre-filled.
 */
export async function clearAll() {
  await Promise.all([removeItem(SESSION_KEY), removeItem(PASSWORD_KEY)]);
}
