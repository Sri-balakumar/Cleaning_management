import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { registerDevice as sendToken, unregisterDevice } from '../api/cleaning';
import { log } from '../utils/log';

/**
 * Handing the server an address Firebase can deliver to.
 *
 * Managers only. Nobody else is ever notified, so registering everybody's
 * phone would collect device tokens the server has no use for -- and a token
 * is the address a phone is reachable at, which is not worth storing without
 * a reason.
 *
 * Nothing here may block signing in. A phone with no Play Services, a refused
 * permission, an emulator, a build that was made before this existed -- every
 * one of those has to end with the person signed in and using the app, with
 * the Notifications list still working. That is why every step returns rather
 * than throws, and why the caller does not await anything it cannot survive.
 */

/**
 * The channel the notification is filed under.
 *
 * Must match CHANNEL_ID in the server's cleaning_push_provider.py. Android 8+
 * silently drops a notification whose channel does not exist, so a mismatch
 * here is a feature that appears to work everywhere except the actual phone.
 */
export const CHANNEL_ID = 'low-match';

/**
 * How a notification behaves while the app is open and in front.
 *
 * Android draws the ones that arrive while the app is closed by itself -- that
 * is what the server's `notification` block is for. This covers only the other
 * case, and without it a round flagged while somebody has the app open makes no
 * sound and shows nothing.
 *
 * SDK 53 replaced shouldShowAlert with these two; the old name is ignored.
 */
export function installNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Ask Android for this phone's FCM token and give it to Odoo.
 *
 * Returns the token on success and null on any refusal, so the caller can
 * remember it for sign-out without having to ask twice.
 */
export async function registerForPush({ baseUrl, isManager }) {
  if (!isManager) return null;
  // iOS would need an APNs key in Firebase and an Apple developer account,
  // neither of which is set up. An iOS manager gets the in-app list, which is
  // why that list exists rather than being a nicety.
  if (Platform.OS !== 'android') return null;

  try {
    // FIRST, before the token is asked for. On Android 13+ the channel has to
    // exist or getDevicePushTokenAsync returns nothing at all -- and it fails
    // by being empty rather than by throwing, which is a miserable thing to
    // debug after the fact.
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Low rounds',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain !== false) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
    if (!granted) {
      log('push', 'notifications not permitted - falling back to the list');
      return null;
    }

    // getDevicePushTokenAsync, not getExpoPushTokenAsync: the server talks to
    // Firebase directly, so it needs the raw FCM address rather than one of
    // Expo's, which only Expo's own service can deliver to.
    const { data: token } = await Notifications.getDevicePushTokenAsync();
    if (!token) {
      log('push', 'no device token returned');
      return null;
    }

    await sendToken(baseUrl, token, 'android');
    log('push', 'registered for notifications');
    return token;
  } catch (e) {
    // Expo Go on Android cannot do this at all since SDK 53, and that is the
    // most likely thing to land here during development. Not worth a message
    // to the user: the app works, this one extra does not.
    log('push', `could not register: ${e?.message || e}`);
    return null;
  }
}

/**
 * Stop this phone being notified.
 *
 * Called on sign-out. Without it a manager who hands their phone on, or signs
 * out for the last time, keeps being sent every low round forever -- Firebase
 * has no idea anything changed, because the app is still installed.
 */
export async function unregisterFromPush({ baseUrl, token }) {
  if (!token) return;
  try {
    await unregisterDevice(baseUrl, token);
  } catch (e) {
    // Signing out must not fail because the server could not be told. The
    // token dies on the server anyway the first time Firebase reports it gone.
    log('push', `could not unregister: ${e?.message || e}`);
  }
}
