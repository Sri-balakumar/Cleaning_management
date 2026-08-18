import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
/**
 * Height of the on-screen keyboard, or 0 while it is hidden.
 *
 * Needed because SDK 54 turns on Android edge-to-edge by default, and
 * edge-to-edge stops `adjustResize` from shrinking the window -- the system
 * assumes the app positions itself against the insets. That leaves
 * `KeyboardAvoidingView` unable to lift fields clear of the keyboard on its
 * own. `react-native-keyboard-controller` is the usual answer but ships native
 * code, so it cannot run in Expo Go; this hook is the JS-only equivalent.
 */
export function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    // iOS exposes the `will` events, which fire early enough to animate with
    // the keyboard instead of snapping after it has finished appearing.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (event) =>
      setHeight(event.endCoordinates?.height ?? 0),
    );
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}
