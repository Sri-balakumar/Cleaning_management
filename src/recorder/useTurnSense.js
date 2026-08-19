import { useEffect, useRef, useState } from 'react';
import { Gyroscope } from 'expo-sensors';

/**
 * How far the phone has turned since it was last reset, in degrees.
 *
 * The gyroscope rather than the compass, on purpose. A showroom is full of
 * steel shelving, and a magnetometer indoors can sit still through a quarter
 * turn or jump forty degrees standing still - which is exactly the reading this
 * is meant to be sure about. The gyroscope measures rotation itself and does
 * not care what the room is made of. It drifts, but only over minutes, and the
 * question here spans the few seconds between one photograph and the next.
 *
 * The answer is guidance and nothing more. Nothing in the round waits on it:
 * a phone with no gyroscope, or one that reads nonsense, must never be able to
 * stop somebody finishing their work. The real check on whether they faced the
 * right way is the comparison the server runs afterwards.
 */

// Radians per second on the axis that runs up through a phone held upright. The
// app is portrait-locked, so a person turning on the spot rotates about it.
const UPDATE_MS = 100;

// Below this the reading is hand-shake, not turning. Integrating it would have
// the meter creep up while somebody stands still holding the phone.
const NOISE_FLOOR = 0.05; // rad/s, about 3 degrees per second

export function useTurnSense(active) {
  const [degrees, setDegrees] = useState(0);
  const [available, setAvailable] = useState(null);

  const total = useRef(0);
  const last = useRef(null);

  useEffect(() => {
    let subscription;
    let live = true;

    if (!active) return undefined;

    void (async () => {
      let ok = false;
      try {
        ok = await Gyroscope.isAvailableAsync();
      } catch {
        ok = false;
      }
      if (!live) return;
      setAvailable(ok);
      if (!ok) return;

      Gyroscope.setUpdateInterval(UPDATE_MS);
      subscription = Gyroscope.addListener(({ y }) => {
        const now = Date.now();
        // The first reading only starts the clock: there is no interval behind
        // it yet, and assuming one would book a turn that never happened.
        if (last.current === null) {
          last.current = now;
          return;
        }
        const seconds = (now - last.current) / 1000;
        last.current = now;
        const rate = Math.abs(y);
        if (rate < NOISE_FLOOR) return;
        total.current += rate * seconds * (180 / Math.PI);
        setDegrees(total.current);
      });
    })();

    return () => {
      live = false;
      subscription?.remove();
      last.current = null;
    };
  }, [active]);

  const reset = () => {
    total.current = 0;
    last.current = null;
    setDegrees(0);
  };

  return { degrees, available, reset };
}
