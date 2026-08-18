import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
/**
 * expo-secure-store (SDK 54) has two constraints that shape this module:
 *
 *  1. Values over roughly 2048 bytes can be rejected by iOS. So only small
 *     scalars are persisted -- notably the base64 avatar is NEVER stored here,
 *     it would blow the limit on its own. It lives in memory for the session.
 *  2. There is no web implementation. On web we fall back to localStorage so
 *     `npm run web` stays usable for UI work; native keeps Keychain/Keystore.
 */
const MAX_SECURE_VALUE_BYTES = 1800;
const SESSION_KEY = 'cleanpro.session';
const PASSWORD_KEY = 'cleanpro.password';
const LAST_SERVER_KEY = 'cleanpro.lastServer';
const isWeb = Platform.OS === 'web';
async function setItem(key, value) {
  if (isWeb) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Private-mode browsers can refuse writes; session simply won't persist.
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}
async function getItem(key) {
  if (isWeb) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}
async function removeItem(key) {
  if (isWeb) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  await SecureStore.deleteItemAsync(key);
}
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
