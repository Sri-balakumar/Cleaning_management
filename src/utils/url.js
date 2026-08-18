import { AppError } from '../api/errors';
/**
 * Parsed by hand rather than with `new URL()` on purpose: React Native's URL
 * polyfill is incomplete and does not reliably expose host/port.
 */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const AUTHORITY_RE = /^(?:[^@\s]*@)?(\[[0-9a-f:]+\]|[^:\s]+)(?::(\d+))?$/i;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** The backend's own web-client paths, stripped so pasting a browser URL just works. */
const BACKEND_UI_PATH = /\/(web(\/(login|database\/(manager|selector))?)?|odoo(\/.*)?)\/?$/i;
export function isLocalHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '[::1]') return true;
  const m = IPV4_RE.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
function isValidHost(host) {
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) return true; // IPv6 literal
  const m = IPV4_RE.exec(host);
  if (m) return [1, 2, 3, 4].every((i) => Number(m[i]) <= 255);
  return HOSTNAME_RE.test(host) && host.length <= 253;
}
/** Split raw user input into its parts. Throws `invalid_url` if unusable. */
export function parseServerInput(raw) {
  const cleaned = (raw ?? '').trim().replace(/\s+/g, '');
  if (!cleaned) throw new AppError('invalid_url', 'Enter your server address.');
  // The scheme is peeled off explicitly. Leaving it to one combined regex lets
  // the pattern backtrack and read "http" itself as the hostname for input
  // like "http://", which then looks valid when it very much is not.
  let scheme = null;
  let rest = cleaned;
  const schemeMatch = SCHEME_RE.exec(cleaned);
  if (schemeMatch) {
    const found = schemeMatch[1].toLowerCase();
    if (found !== 'http' && found !== 'https') {
      throw new AppError('invalid_url', 'Only http:// and https:// addresses are supported.');
    }
    scheme = found;
    rest = cleaned.slice(schemeMatch[0].length);
  } else if (cleaned.includes('//')) {
    throw new AppError('invalid_url');
  }
  if (!rest) throw new AppError('invalid_url', 'Enter your server address.');
  const slash = rest.indexOf('/');
  const authorityPart = slash === -1 ? rest : rest.slice(0, slash);
  const path = (slash === -1 ? '' : rest.slice(slash))
    .replace(/[?#].*$/, '')
    .replace(BACKEND_UI_PATH, '')
    .replace(/\/+$/, '');
  const match = AUTHORITY_RE.exec(authorityPart);
  if (!match) throw new AppError('invalid_url');
  const host = match[1];
  const port = match[2] ?? null;
  if (!isValidHost(host)) throw new AppError('invalid_url');
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new AppError('invalid_url');
  return { scheme, host, port, path, authority: port ? `${host}:${port}` : host };
}
/**
 * Base URLs to try, in order. When the user omits the scheme we guess: local
 * hosts and the classic backend ports are almost always plain HTTP, everything
 * else is almost always HTTPS. Both are attempted either way.
 */
export function candidateBaseUrls(raw) {
  const { scheme, host, port, path, authority } = parseServerInput(raw);
  if (scheme) return [`${scheme}://${authority}${path}`];
  const httpFirst = isLocalHost(host) || port === '8069' || port === '8071' || port === '80';
  return httpFirst
    ? [`http://${authority}${path}`, `https://${authority}${path}`]
    : [`https://${authority}${path}`, `http://${authority}${path}`];
}
/** True once the input is complete enough to be worth probing the network for. */
export function looksProbeworthy(raw) {
  try {
    const { host, port } = parseServerInput(raw);
    return host.includes('.') || !!port || isLocalHost(host);
  } catch {
    return false;
  }
}
/** Strip the scheme for compact display in the UI. */
export function displayUrl(baseUrl) {
  return baseUrl.replace(/^https?:\/\//, '');
}
