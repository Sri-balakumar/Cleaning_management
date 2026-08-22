import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { registerDevice as sendToken, unregisterDevice } from '../api/cleaning';
import { log } from '../utils/log';

/**
 * Handing the server an address Expo can deliver to.
 *
 * Expo is a relay, not a replacement for Firebase: the service account key is
 * uploaded to EAS with `eas credentials`, and Expo sends over FCM on the
 * server's behalf. The phone still needs google-services.json to receive --
 * this file just asks Expo for the address rather than asking Firebase.
 *
 * Shaped after KRA_KPI/services/push.js on purpose, so both apps register the
 * same way.
 *
 * Managers only. Nobody else is ever notified, so registering everybody's
 * phone would collect addresses the server has no use for.
 *
 * Nothing here may block signing in. A phone with no Play Services, a refused
 * permission, an emulator, a build made before EAS was set up -- every one of
 * those has to end with the person signed in and using the app, with the
 * Notifications list still working. Hence every path returns rather than
 * throws.
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
 * Which EAS project minted our tokens.
 *
 * getExpoPushTokenAsync requires it in SDK 54. It lands in
 * `expoConfig.extra.eas.projectId` once `eas init` has been run; easConfig is
 * the older shape, kept as a fallback so an existing build does not stop
 * registering the day the config moves.
 */
function getProjectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    Constants?.easConfig?.projectId ||
    null
  );
}

/**
 * How a notification behaves while the app is open and in front.
 *
 * Android draws the ones that arrive while the app is closed by itself. This
 * covers only the other case, and without it a round flagged while somebody
 * has the app open makes no sound and shows nothing.
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
 * Ask Expo for this phone's push token and give it to Odoo.
 *
 * Returns the token on success and null on any refusal, so the caller can
 * remember it for sign-out without having to ask twice.
 */
export async function registerForPush({ baseUrl, isManager }) {
  if (!isManager) return null;
  // An emulator cannot receive a push and would only create a row that never
  // works. Same check KRA_KPI makes, and for the same reason.
  if (!Device.isDevice) {
    log('push', 'not a physical device - skipping registration');
    return null;
  }

  try {
    // FIRST, before the token is asked for. On Android 13+ the channel has to
    // exist or the token call returns nothing at all -- and it fails by being
    // empty rather than by throwing, which is a miserable thing to debug after
    // the fact.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Low rounds',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

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

    const projectId = getProjectId();
    if (!projectId) {
      // Without one the token call throws. Bailing here keeps that a log line
      // rather than an exception, and says which command fixes it.
      log('push', 'no EAS projectId - remote push is inert until `eas init`');
      return null;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) {
      log('push', 'no Expo push token returned');
      return null;
    }

    await sendToken(baseUrl, token, Platform.OS, {
      device: Device.deviceName || Device.modelName || '',
      // Sent so the server can group its requests by project. Expo rejects a
      // request whose messages span two projects -- and rejects the WHOLE
      // request, so one token left behind by an older projectId would take
      // every other manager's notification down with it.
      projectId,
    });
    log('push', 'registered for notifications');
    return token;
  } catch (e) {
    // Expo Go on Android cannot do this at all since SDK 53, which is the most
    // likely thing to land here during development. Not worth telling the user
    // about: the app works, this one extra does not.
    log('push', `could not register: ${e?.message || e}`);
    return null;
  }
}

/**
 * Stop this phone being notified.
 *
 * Called on sign-out. Without it a manager who hands their phone on, or signs
 * out for the last time, keeps being sent every low round forever -- Expo has
 * no idea anything changed, because the app is still installed.
 */
export async function unregisterFromPush({ baseUrl, token }) {
  if (!token) return;
  try {
    await unregisterDevice(baseUrl, token);
  } catch (e) {
    // Signing out must not fail because the server could not be told.
    log('push', `could not unregister: ${e?.message || e}`);
  }
}
