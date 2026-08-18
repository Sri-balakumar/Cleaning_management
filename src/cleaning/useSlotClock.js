import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { log } from '../utils/log';

/**
 * Keeps the round countdowns ticking without ever letting the phone decide that
 * a round has opened.
 *
 * The rule this exists to enforce: the countdown on screen is a *prediction*,
 * and the server is the only thing allowed to say a round is open. When the
 * local countdown reaches zero the button does not light up -- the card shows
 * "Opening..." and asks the server. If the phone's clock happens to be three
 * minutes fast, all that happens is a brief flicker; the button never turns on
 * early and then has the recording refused on upload.
 *
 * Monotonic time only. Date.now() jumps when the clock is corrected or the
 * timezone changes, which would make a countdown leap or stall.
 */
const now = () =>
  typeof global.performance?.now === 'function' ? global.performance.now() : Date.now();

export function useSlotClock(fetchState) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
    countdowns: {},
    pending: {},
  });

  const syncedAt = useRef(0);
  const baseline = useRef([]);
  const pending = useRef({});
  const syncTimer = useRef(null);
  const tickTimer = useRef(null);
  const destroyed = useRef(false);
  const paused = useRef(false);
  // Held in a ref so the tick interval never closes over a stale copy.
  const syncRef = useRef(null);

  const clearSyncTimer = () => {
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
  };

  const scheduleNextSync = useCallback((data, overrideSeconds) => {
    clearSyncTimer();
    if (destroyed.current || paused.current) return;

    let delay = overrideSeconds;
    if (delay === undefined) {
      const near = data?.near_window_seconds || 120;
      // Closer to a boundary, ask more often -- so the moment a round opens is
      // picked up quickly without polling hard all day.
      const soonest = baseline.current.reduce((min, slot) => {
        const seconds =
          slot.state === 'upcoming'
            ? slot.seconds_until_open
            : slot.state === 'open'
              ? slot.seconds_until_close
              : Infinity;
        return Math.min(min, seconds);
      }, Infinity);
      delay = soonest <= near ? data?.poll_seconds_near || 15 : data?.poll_seconds || 60;
    }
    log('slot-clock', `next sync in ${delay}s`);
    syncTimer.current = setTimeout(() => syncRef.current?.(), delay * 1000);
  }, []);

  const sync = useCallback(async () => {
    if (destroyed.current) return;
    const startedAt = now();
    log('slot-clock', 'sync start');
    let data;
    try {
      data = await fetchState();
    } catch (error) {
      if (destroyed.current) return;
      log('slot-clock', 'sync failed', error?.message ?? error);
      setState((prev) => ({ ...prev, error, loading: false }));
      scheduleNextSync(null, 15);
      return;
    }
    if (destroyed.current) return;
    const landedAt = now();
    log('slot-clock', `sync ok in ${Math.round(landedAt - startedAt)}ms`, {
      slots: (data.slots || []).length,
      ok: data.ok,
      is_allowed: data.is_allowed,
    });

    // The server worked these figures out somewhere around the middle of the
    // round trip, so they are already slightly stale on arrival. Milliseconds
    // on a local network, worth correcting for over a slow link.
    const inFlight = (landedAt - startedAt) / 2000;

    syncedAt.current = landedAt;
    baseline.current = (data.slots || []).map((slot) => ({
      ...slot,
      seconds_until_open: Math.max(0, slot.seconds_until_open - inFlight),
      seconds_until_close: Math.max(0, slot.seconds_until_close - inFlight),
    }));
    pending.current = {};

    setState({ loading: false, error: null, data, countdowns: {}, pending: {} });
    scheduleNextSync(data);
  }, [fetchState, scheduleNextSync]);

  syncRef.current = sync;

  const tick = useCallback(() => {
    if (destroyed.current || !baseline.current.length) return;
    const elapsed = (now() - syncedAt.current) / 1000;
    const countdowns = {};
    let needsSync = false;

    for (const slot of baseline.current) {
      const untilOpen = Math.max(0, slot.seconds_until_open - elapsed);
      const untilClose = Math.max(0, slot.seconds_until_close - elapsed);
      countdowns[slot.id] = { untilOpen, untilClose };

      // The countdown ran out. Do NOT flip the button here -- ask the server
      // and let its answer decide.
      const reachedBoundary =
        (slot.state === 'upcoming' && untilOpen === 0) ||
        (slot.state === 'open' && untilClose === 0);
      if (reachedBoundary && !pending.current[slot.id]) {
        log('slot-clock', `slot ${slot.id} (${slot.state}) reached its boundary - asking the server`);
        pending.current[slot.id] = true;
        needsSync = true;
      }
    }

    setState((prev) => ({ ...prev, countdowns, pending: { ...pending.current } }));
    if (needsSync) void syncRef.current?.();
  }, []);

  useEffect(() => {
    destroyed.current = false;
    void sync();
    tickTimer.current = setInterval(tick, 1000);

    // A backgrounded phone stops timing reliably, so re-sync on the way back
    // rather than trusting a countdown that was frozen in someone's pocket.
    const subscription = AppState.addEventListener('change', (status) => {
      log('slot-clock', `app state -> ${status}`);
      if (status === 'active' && !paused.current) void syncRef.current?.();
    });

    return () => {
      destroyed.current = true;
      clearSyncTimer();
      if (tickTimer.current) clearInterval(tickTimer.current);
      subscription.remove();
    };
    // Mount only: sync/tick are stable and re-running this would restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Stop polling while the camera is open in front of this screen. */
  const pause = useCallback(() => {
    log('slot-clock', 'paused');
    paused.current = true;
    clearSyncTimer();
  }, []);

  const resume = useCallback(() => {
    log('slot-clock', 'resumed');
    paused.current = false;
    void syncRef.current?.();
  }, []);

  return { ...state, refresh: sync, pause, resume };
}

/**
 * "4m 20s" / "45s" -- compact enough for a button caption.
 *
 * Takes the dictionary because the unit letters differ by language. Defaults to
 * English so a caller that forgets still renders something sensible.
 */
export function formatCountdown(seconds, t) {
  const h = t?.unitHour ?? 'h';
  const m = t?.unitMinute ?? 'm';
  const s = t?.unitSecond ?? 's';
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}${h} ${minutes}${m}`;
  if (minutes) return `${minutes}${m} ${secs}${s}`;
  return `${secs}${s}`;
}
