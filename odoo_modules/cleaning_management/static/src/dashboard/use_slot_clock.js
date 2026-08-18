import { browser } from "@web/core/browser/browser";
import { useState, onWillStart, onWillUnmount, useExternalListener } from "@odoo/owl";

/**
 * Keeps the dashboard's countdowns ticking without ever letting the browser
 * decide that a round has opened.
 *
 * The rule this hook exists to enforce: the countdown shown on screen is a
 * *prediction*, and the server is the only thing allowed to say a round is
 * open. When the local countdown reaches zero the button does not light up - it
 * shows "Opening..." and asks the server. If the computer's clock happens to be
 * three minutes fast, all that happens is a brief flicker; the button never
 * turns on early and then has the recording refused.
 *
 * @param {Function} fetchState returns the dashboard payload from the server
 */
export function useSlotClock(fetchState) {
    const state = useState({
        loading: true,
        error: null,
        data: null,
        // Live per-slot countdowns, recalculated every second.
        countdowns: {},
        pending: {},
        // Declared up front so the template tracks it from the first render.
        paused: false,
    });

    let syncedAtPerf = 0;
    let baseline = [];
    let tickHandle = null;
    let syncHandle = null;
    let lastFocusSync = 0;
    let destroyed = false;

    function clearSyncTimer() {
        if (syncHandle) {
            browser.clearTimeout(syncHandle);
            syncHandle = null;
        }
    }

    function scheduleNextSync(overrideSeconds) {
        clearSyncTimer();
        if (destroyed || state.paused) {
            return;
        }
        let delay = overrideSeconds;
        if (delay === undefined) {
            const data = state.data || {};
            const near = data.near_window_seconds || 120;
            // Closer to a boundary, ask more often - so the moment a round
            // opens is picked up quickly without polling hard all day.
            const soonest = Math.min(
                ...baseline.map((slot) =>
                    slot.state === "upcoming"
                        ? slot.seconds_until_open
                        : slot.state === "open"
                        ? slot.seconds_until_close
                        : Infinity
                ),
                Infinity
            );
            delay =
                soonest <= near
                    ? data.poll_seconds_near || 15
                    : data.poll_seconds || 60;
        }
        syncHandle = browser.setTimeout(() => sync(), delay * 1000);
    }

    async function sync() {
        if (destroyed) {
            return;
        }
        const startedAt = browser.performance.now();
        let data;
        try {
            data = await fetchState();
        } catch (error) {
            if (destroyed) {
                return;
            }
            state.error = error;
            state.loading = false;
            scheduleNextSync(15);
            return;
        }
        if (destroyed) {
            return;
        }
        const landedAt = browser.performance.now();

        // The server worked these figures out somewhere around the middle of
        // the round trip, so they are already slightly out of date by the time
        // they arrive. On a local network this is a few milliseconds; over a
        // slow link it is worth correcting for.
        const inFlight = (landedAt - startedAt) / 2000;

        syncedAtPerf = landedAt;
        baseline = (data.slots || []).map((slot) => ({
            ...slot,
            seconds_until_open: Math.max(0, slot.seconds_until_open - inFlight),
            seconds_until_close: Math.max(0, slot.seconds_until_close - inFlight),
        }));

        state.data = data;
        state.error = null;
        state.loading = false;
        state.pending = {};
        tick();
        scheduleNextSync();
    }

    function tick() {
        if (destroyed || !baseline.length) {
            return;
        }
        const elapsed = (browser.performance.now() - syncedAtPerf) / 1000;
        const countdowns = {};
        let needsSync = false;

        for (const slot of baseline) {
            const untilOpen = Math.max(0, slot.seconds_until_open - elapsed);
            const untilClose = Math.max(0, slot.seconds_until_close - elapsed);
            countdowns[slot.id] = { untilOpen, untilClose };

            // Countdown ran out. Do NOT change the button here - ask the server
            // and let its answer decide.
            if (slot.state === "upcoming" && untilOpen === 0 && !state.pending[slot.id]) {
                state.pending[slot.id] = true;
                needsSync = true;
            }
            if (slot.state === "open" && untilClose === 0 && !state.pending[slot.id]) {
                state.pending[slot.id] = true;
                needsSync = true;
            }
        }
        state.countdowns = countdowns;

        if (needsSync) {
            sync();
        }
    }

    /** Stop polling while a recording is in progress behind a dialog. */
    function pause() {
        state.paused = true;
        clearSyncTimer();
    }

    function resume() {
        state.paused = false;
        sync();
    }

    onWillStart(async () => {
        await sync();
        tickHandle = browser.setInterval(() => tick(), 1000);
    });

    onWillUnmount(() => {
        destroyed = true;
        clearSyncTimer();
        if (tickHandle) {
            browser.clearInterval(tickHandle);
            tickHandle = null;
        }
    });

    // A laptop lid closed at 08:40 and opened at 09:20 leaves the timer far
    // behind. Re-checking when the page becomes visible again makes that fix
    // itself instead of showing a stale countdown.
    useExternalListener(document, "visibilitychange", () => {
        if (!document.hidden && !state.paused) {
            sync();
        }
    });

    useExternalListener(window, "focus", () => {
        const now = Date.now();
        if (now - lastFocusSync > 5000 && !state.paused) {
            lastFocusSync = now;
            sync();
        }
    });

    return { state, sync, pause, resume };
}
