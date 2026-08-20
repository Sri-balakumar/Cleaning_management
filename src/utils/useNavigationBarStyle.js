import { useEffect } from 'react';
import { useIsFocused } from '@react-navigation/native';
import * as NavigationBar from 'expo-navigation-bar';

/**
 * Keep Android's navigation buttons readable against the screen behind them.
 *
 * Edge-to-edge makes the system bar transparent and draws the app underneath
 * it, so the bar has no colour of its own to set -- the only lever left is
 * whether its buttons are drawn light or dark. On a black camera screen the
 * dark buttons the rest of the app asks for are invisible, which is what makes
 * the bar look broken rather than merely wrong.
 *
 * Tied to focus rather than to mount: two screens can be mounted at once while
 * a push animates, and the one being left would otherwise reset the style out
 * from under the one arriving. Focus is the only signal that says which screen
 * the buttons are actually sitting on.
 *
 * `dark` on the way out, because everything else in this app is a light screen.
 *
 * A no-op off Android: setStyle throws outright where it is unsupported, so
 * every call is guarded rather than chained.
 */
export function useNavigationBarStyle(style, active = true) {
  const isFocused = useIsFocused();

  useEffect(() => {
    // `active` is for the full-screen modals, which stay mounted behind a
    // `visible` prop: without it they would claim the buttons for as long as
    // the screen holding them was open, closed or not.
    if (!isFocused || !active) return undefined;
    try {
      NavigationBar.setStyle(style);
    } catch {}
    return () => {
      try {
        NavigationBar.setStyle('dark');
      } catch {}
    };
  }, [active, isFocused, style]);
}
