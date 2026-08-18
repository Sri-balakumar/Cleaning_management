import { Platform } from 'react-native';
import { AppError } from './errors';
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * The backend hands the session back as an HttpOnly `session_id` cookie. React
 * Native's native cookie jars (OkHttp / NSHTTPCookieStorage) do persist it, but
 * inconsistently across platforms and app restarts -- so we also scrape the
 * header ourselves and replay it explicitly. Belt and braces.
 *
 * On web the browser owns the cookie jar and `Cookie` is a forbidden header, so
 * we never set it there.
 */
let sessionCookie = null;
export const getSessionCookie = () => sessionCookie;
export const setSessionCookie = (value) => {
  sessionCookie = value;
};
function captureSessionCookie(response) {
  if (Platform.OS === 'web') return;
  const raw = response.headers.get('set-cookie');
  if (!raw) return;
  const match = /session_id=([^;,\s]+)/i.exec(raw);
  if (match && match[1] && match[1] !== 'undefined') sessionCookie = match[1];
}
/** Map the server's error payload onto one of our kinds. */
function classifyServerError(error) {
  const data = error?.data ?? {};
  const name = String(data.name ?? '');
  const serverMessage = String(data.message ?? error?.message ?? '').trim();
  const combined = `${name} ${serverMessage}`.toLowerCase();
  let kind = 'server';
  if (combined.includes('accessdenied') || combined.includes('access denied')) {
    kind = 'invalid_credentials';
  } else if (combined.includes('sessionexpired') || combined.includes('session expired')) {
    kind = 'session_expired';
  } else if (combined.includes('accesserror')) {
    kind = 'access_error';
  }
  // For `server` we surface the server's own wording; for the rest our copy is clearer.
  return new AppError(
    kind,
    kind === 'server' ? serverMessage || undefined : undefined,
    serverMessage || name,
  );
}
/**
 * The only place `fetch` is called. Wraps params in the JSON-RPC 2.0 envelope
 * the backend expects and normalises every failure into an AppError.
 */
export async function rpc(baseUrl, path, params = {}, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (Platform.OS !== 'web' && sessionCookie) headers.Cookie = `session_id=${sessionCookie}`;
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params,
        id: Math.floor(Math.random() * 1_000_000_000),
      }),
    });
  } catch (error) {
    // A self-signed certificate also lands here as "Network request failed".
    throw timedOut ? new AppError('timeout') : new AppError('network', undefined, String(error));
  } finally {
    clearTimeout(timer);
  }
  captureSessionCookie(response);
  const text = await response.text();
  if (response.status === 404) {
    throw new AppError('incompatible', undefined, `HTTP 404 for ${path}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // HTML from a reverse proxy, a login page, or an unrelated host.
    throw new AppError(
      response.status >= 500 ? 'server' : 'incompatible',
      response.status >= 500 ? `The server returned HTTP ${response.status}.` : undefined,
      text.slice(0, 200),
    );
  }
  // Critical: the backend answers HTTP 200 even when the call failed. The error lives
  // in the body, so it must be checked before `result` is trusted.
  if (payload && typeof payload === 'object' && payload.error) {
    throw classifyServerError(payload.error);
  }
  if (!response.ok) {
    throw new AppError('server', `The server returned HTTP ${response.status}.`);
  }
  return payload?.result;
}
