/**
 * What time it is on the server.
 *
 * A round is refused unless the moment it says it started matches the server's
 * own clock -- the window it fell in, the day it belongs to, and a few minutes
 * either side of now. All three are decided on the server, so a phone whose
 * clock is a few minutes out records happily and is then turned away on upload,
 * with a message about the clock that nobody reading it can act on.
 *
 * So the phone's clock is not used for any of it. The dashboard already sends
 * `server_now_ts` for exactly this purpose, and the web recorder has always
 * measured its offset from it; this is the app finally doing the same.
 *
 * Anchored on monotonic time rather than Date.now(), for the reason spelled out
 * in useSlotClock: a wall clock jumps when it is corrected or the timezone
 * changes, and an offset measured against one that has since jumped is worse
 * than no offset at all. Here the anchor survives the clock being changed
 * mid-round, which is precisely when this has to hold.
 */
const monotonic = () =>
  typeof global.performance?.now === 'function' ? global.performance.now() : Date.now();

/** `{ serverMs, atPerf }` from the last sync, or null before the first one. */
let anchor = null;

/**
 * Remember what the server said the time was.
 *
 * Takes the whole dashboard payload rather than the field, so callers do not
 * each have to remember the name, and a response without one simply leaves the
 * previous anchor in place -- an older server that sends no time should not
 * quietly reset the app to trusting the phone.
 */
export function noteServerTime(state) {
  const seconds = state?.server_now_ts;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;
  anchor = { serverMs: seconds * 1000, atPerf: monotonic() };
}

/**
 * The server's clock, as a Date.
 *
 * Falls back to the phone's own before the first sync -- which in practice
 * cannot happen for a recording, since the recorder asks the server what to
 * record before it records anything. Better a stamp that may be wrong than no
 * stamp at all, which the server refuses outright.
 */
export function serverNow() {
  if (!anchor) return new Date();
  return new Date(Math.round(anchor.serverMs + (monotonic() - anchor.atPerf)));
}

/** For the diagnostics line: how far the phone is from the server, in seconds. */
export function serverOffsetSeconds() {
  if (!anchor) return null;
  return Math.round((serverNow().getTime() - Date.now()) / 1000);
}
