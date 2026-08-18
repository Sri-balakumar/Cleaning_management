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
 */
const isWeb = Platform.OS === 'web';

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
  if (isWeb) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
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
