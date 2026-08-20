/**
 * The verdict bands the server can send, in one place.
 *
 * Three screens read `match_level` - the photographs card, the Comparisons
 * list and the recording detail - and each of them used to carry its own copy
 * of this. When the server grew a fifth band, two of the three silently fell
 * back to "Not compared" and one of them printed a score for a round nothing
 * had been measured on. That is what a duplicated list of constants costs.
 *
 * Colours are deliberately NOT here. The badge on a card and the dot in a list
 * are styled differently on purpose; what must never differ is which bands
 * exist and which of them carry a real number.
 */

/** Band -> translation key. Keep in step with MATCH_LEVELS on the server. */
export const MATCH_BAND_KEYS = {
  ok: 'matchOk',
  warn: 'matchWarn',
  alert: 'matchAlert',
  unaligned: 'matchUnaligned',
  unknown: 'matchUnknown',
};

/**
 * The bands that carry a real score.
 *
 * Tested FOR rather than testing against the ones that do not. Excluding
 * 'unknown' alone is precisely how 'unaligned' came to count as scored the day
 * the server started sending it, and printed `Match: 0%` for a pair that could
 * not be lined up at all. A band added tomorrow is unscored until it is named
 * here, which is the safe direction to be wrong in.
 */
export const SCORED_LEVELS = ['ok', 'warn', 'alert'];

/** The label for a band, falling back rather than rendering blank. */
export const bandKey = (level) => MATCH_BAND_KEYS[level] || MATCH_BAND_KEYS.unknown;

/** Does this round carry a number worth showing? */
export const isScored = (level) => SCORED_LEVELS.includes(level);
