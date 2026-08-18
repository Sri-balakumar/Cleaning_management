/**
 * Development logging.
 *
 * Every line carries a scope tag - `[rounds]`, `[slot-clock]` - so one noisy
 * area can be found (or filtered out) in the Metro output with a search, and
 * the whole thing goes quiet in a production build.
 */
export function log(scope, message, data) {
  if (!__DEV__) return;
  if (data === undefined) console.log(`[${scope}] ${message}`);
  else console.log(`[${scope}] ${message}`, data);
}
