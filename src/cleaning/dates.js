/**
 * Reading the dates and times the backend sends.
 *
 * Here rather than in a screen because four of them need the same answers. A
 * "Today" that means one thing on History and another on Comparisons is the
 * kind of difference nobody notices until it is confusing.
 */

/** The backend hands back naive UTC: "YYYY-MM-DD HH:MM:SS". */
export function parseServerDate(value) {
  if (!value) return null;
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Clock time only -- the calendar date is the group header above it. */
export function formatTime(value) {
  const parsed = parseServerDate(value);
  if (!parsed) return '';
  return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Date and time together, where there is no date header to sit under. */
export function formatMoment(value) {
  const parsed = parseServerDate(value);
  if (!parsed) return undefined;
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * `slot_date` is a plain "YYYY-MM-DD" with no timezone to reason about, which
 * is exactly why the server sends it that way: the office's calendar day, not
 * whatever day it happens to be in UTC.
 */
export function formatGroupDate(isoDate, t) {
  const [y, m, d] = (isoDate || '').split('-').map(Number);
  if (!y) return isoDate || '';
  const date = new Date(y, m - 1, d);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const today = new Date();
  if (sameDay(date, today)) return t.today;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return t.yesterday;

  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The same day, spelled out, where no Today/Yesterday shorthand is wanted. */
export function formatDay(isoDate) {
  const [y, m, d] = (isoDate || '').split('-').map(Number);
  if (!y) return isoDate || '';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
