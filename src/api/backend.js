import { AppError } from './errors';
import { rpc, setSessionCookie } from './rpcClient';
import { candidateBaseUrls } from '../utils/url';
/**
 * Listing databases is a foreground probe the user is watching, so it fails
 * fast. Authentication keeps the client's longer default -- signing in may
 * legitimately take longer than reading a list of names.
 */
const PROBE_TIMEOUT_MS = 6_000;
const USER_FIELDS = [
  'name',
  'login',
  'email',
  // No 'mobile': the server dropped that field from the user record, and asking
  // for it fails the whole read -- taking every other field on this list with
  // it, so the profile came back empty instead of merely missing a number.
  'phone',
  'function',
  'image_128',
  'partner_id',
  'company_id',
  'tz',
  'lang',
  'login_date',
];
const asDbList = (result) => {
  if (!Array.isArray(result)) return null;
  const databases = result.filter((d) => typeof d === 'string' && d.length > 0);
  return { databases, listingDisabled: databases.length === 0 };
};
/**
 * Ask one specific base URL for its database list.
 *
 * Servers with `list_db = False` -- very common in production -- reject this
 * with a server-side error rather than an HTTP error. That still proves we are
 * talking to the backend, so it resolves as `listingDisabled` and the UI falls back to
 * manual entry.
 */
async function listDatabasesAt(baseUrl) {
  try {
    return (
      asDbList(await rpc(baseUrl, '/web/database/list', {}, { timeoutMs: PROBE_TIMEOUT_MS })) ?? {
        databases: [],
        listingDisabled: true,
      }
    );
  } catch (error) {
    const err = AppError.from(error);
    if (err.kind === 'network' || err.kind === 'timeout') throw err;
    if (err.kind !== 'incompatible') {
      // Reached the backend; it just will not list databases. Note that `list_db =
      // False` surfaces as AccessDenied here -- that is NOT a bad password.
      return { databases: [], listingDisabled: true };
    }
  }
  // Only a 404/HTML response gets here: possibly an older backend, so try the
  // legacy endpoint before giving up. (Deprecated for removal in a future release.)
  try {
    return (
      asDbList(
        await rpc(
          baseUrl,
          '/jsonrpc',
          { service: 'db', method: 'list', args: [] },
          { timeoutMs: PROBE_TIMEOUT_MS },
        ),
      ) ?? { databases: [], listingDisabled: true }
    );
  } catch (error) {
    const err = AppError.from(error);
    if (err.kind === 'network' || err.kind === 'timeout' || err.kind === 'incompatible') throw err;
    return { databases: [], listingDisabled: true };
  }
}
/**
 * Resolve raw user input ("erp.mycompany.com", "10.0.2.2:8069") to a working
 * base URL and its database list, trying each scheme candidate in turn.
 */
export async function probeServer(rawInput) {
  const candidates = candidateBaseUrls(rawInput);
  let bestError = null;
  for (const baseUrl of candidates) {
    try {
      const { databases, listingDisabled } = await listDatabasesAt(baseUrl);
      return { baseUrl, databases, listingDisabled };
    } catch (error) {
      const err = AppError.from(error);
      // Name the address that failed, so an unreachable host is visible on the
      // device rather than something the user has to infer.
      const tagged = new AppError(
        err.kind,
        err.message,
        `Tried ${baseUrl}${err.detail ? ` — ${err.detail}` : ''}`,
      );
      // Keep the most informative failure rather than simply the last one.
      // Probing "example.com" tries HTTPS then HTTP; if the first attempt
      // reached a real server and said "incompatible", that beats the second
      // attempt's generic connection failure.
      if (!bestError || errorRank(tagged.kind) > errorRank(bestError.kind)) bestError = tagged;
    }
  }
  throw bestError ?? new AppError('network');
}
/** Errors proving we reached a server outrank plain connection failures. */
function errorRank(kind) {
  return kind === 'network' || kind === 'timeout' ? 0 : 1;
}
/** Validate credentials. Resolves with the server's session_info, or throws. */
export async function authenticate(baseUrl, db, login, password) {
  setSessionCookie(null); // never let a stale session leak into a new login
  const result = await rpc(baseUrl, '/web/session/authenticate', {
    db,
    login,
    password,
  });
  // Some backend builds answer `result: false` instead of raising AccessDenied.
  if (!result || typeof result !== 'object' || !result.uid) {
    throw new AppError('invalid_credentials');
  }
  return result;
}
/** Returns session_info if the stored cookie is still valid, else null. */
export async function getSessionInfo(baseUrl) {
  try {
    const result = await rpc(baseUrl, '/web/session/get_session_info', {});
    return result && typeof result === 'object' && result.uid ? result : null;
  } catch (error) {
    const err = AppError.from(error);
    if (
      err.kind === 'session_expired' ||
      err.kind === 'invalid_credentials' ||
      err.kind === 'access_error'
    ) {
      return null;
    }
    throw err;
  }
}
/** Read the logged-in user's record. Never throws -- profile is best-effort. */
export async function fetchUserRecord(baseUrl, uid, context = {}) {
  try {
    const rows = await rpc(baseUrl, '/web/dataset/call_kw', {
      model: 'res.users',
      method: 'read',
      args: [[uid], USER_FIELDS],
      kwargs: { context },
    });
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch {
    // A permissions quirk on res.users must never block an otherwise good login.
    return null;
  }
}
export async function destroySession(baseUrl) {
  try {
    await rpc(baseUrl, '/web/session/destroy', {}, { timeoutMs: 6000 });
  } catch {
    // Best effort: local sign-out proceeds regardless.
  } finally {
    setSessionCookie(null);
  }
}
