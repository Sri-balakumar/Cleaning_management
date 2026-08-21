import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Key/value storage on the device.
 *
 * expo-secure-store (SDK 54) has no web implementation, so on web this falls
 * back to localStorage and `npm run web` stays usable for UI work; native keeps
 * the Keychain / Android Keystore.
 *
 * Note the size limit: values over roughly 2048 bytes can be rejected by iOS,
 * so callers persist small scalars only.
 *
 * Keys carry the `showroomcheck.` prefix. Builds from before the rename wrote
 * the same values under `cleanpro.`, so a read that misses looks once for the
 * old twin and moves it across -- without that the rename would sign everyone
 * out and lose their remembered server and language. Drop `migrateLegacyKey`
 * and the two prefixes once no pre-rename install is left.
 */
const isWeb = Platform.OS === 'web';

const KEY_PREFIX = 'showroomcheck.';
const LEGACY_PREFIX = 'cleanpro.';

/** Keys already looked for under the old prefix; one miss settles it. */
const legacyChecked = new Set();

async function readRaw(key) {
  if (isWeb) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

export async function setItem(key, value) {
  if (isWeb) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Private-mode browsers can refuse writes; the value simply won't persist.
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function getItem(key) {
  const value = await readRaw(key);
  if (value != null) return value;
  return migrateLegacyKey(key);
}

export async function removeItem(key) {
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

/**
 * One-time move of a pre-rename value onto its current key. Returns the value
 * when there was one to carry over, null otherwise.
 */
async function migrateLegacyKey(key) {
  if (!key.startsWith(KEY_PREFIX) || legacyChecked.has(key)) return null;
  legacyChecked.add(key);

  const legacyKey = LEGACY_PREFIX + key.slice(KEY_PREFIX.length);
  const value = await readRaw(legacyKey);
  if (value == null) return null;

  try {
    await setItem(key, value);
    await removeItem(legacyKey);
  } catch {
    // The old key stays put and the caller still gets its value; clearing the
    // mark lets the next launch retry rather than stranding the migration.
    legacyChecked.delete(key);
  }
  return value;
}
