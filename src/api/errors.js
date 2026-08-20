/**
 * Every failure the network layer can produce, reduced to a small set of kinds
 * the UI can branch on. `message` is always safe to show to a user as-is.
 *
 * Kinds: 'invalid_url' | 'network' | 'timeout' | 'incompatible' |
 * 'invalid_credentials' | 'session_expired' | 'access_error' | 'module_missing' |
 * 'not_a_pdf' |
 * 'server'
 *
 * @typedef {keyof typeof DEFAULT_MESSAGES} AppErrorKind
 */
const DEFAULT_MESSAGES = {
  invalid_url: "That doesn't look like a valid server address.",
  network:
    "Can't reach the server. Check the address, your connection, and whether the server uses a self-signed certificate.",
  timeout: 'The server took too long to respond.',
  incompatible: "The server responded, but it doesn't look like a compatible server.",
  invalid_credentials: 'Wrong username or password.',
  session_expired: 'Your session expired. Please sign in again.',
  access_error: "You don't have permission to do that.",
  module_missing:
    'Showroom Check is not installed on this database. Choose another database, or ask an administrator to install it.',
  not_a_pdf: 'That document is not a PDF, so it cannot be opened here.',
  server: 'The server returned an error.',
};

/**
 * The backend's own name must never appear in the app's interface.
 *
 * Some of what the server sends is shown verbatim -- error banners quote it,
 * and the login screen prints the first part of an unreadable reply under the
 * address field -- and that text carries the vendor name in places the app
 * cannot control ("<vendor> Server Error", the title of an HTML error page).
 * Every such string becomes an AppError before it reaches a screen, so this is
 * the one place that cannot be bypassed.
 *
 * The character classes deliberately leave hostnames and paths alone: a server
 * genuinely at `odoo.local` must still be echoed back as the address that was
 * typed.
 */
const VENDOR_NAME = /(^|[^\w./:-])odoo(?![\w./:-])/gi;
const scrub = (value) =>
  typeof value === 'string'
    ? value
        // The server's two canned headings go first: substituting the word on
        // its own would leave "the server Server Error" behind.
        .replace(/(^|[^\w./:-])odoo server error/gi, '$1Server error')
        .replace(/(^|[^\w./:-])odoo session expired/gi, '$1Session expired')
        .replace(VENDOR_NAME, '$1the server')
    : value;

export class AppError extends Error {
  constructor(kind, message, detail) {
    super(scrub(message || DEFAULT_MESSAGES[kind]));
    this.name = 'AppError';
    this.kind = kind;
    this.detail = scrub(detail);
    // Tracks whether this carries wording of its own -- typically the server's
    // explanation, which is more specific than anything we could substitute and
    // is not ours to translate. See translateError.
    this.hasOwnMessage = Boolean(message);
    // Required so `instanceof` survives the TS -> ES5-ish transpile in Hermes.
    Object.setPrototypeOf(this, AppError.prototype);
  }
  /** Coerce anything thrown into an AppError so callers only handle one type. */
  static from(error) {
    if (error instanceof AppError) return error;
    if (error instanceof Error) return new AppError('network', undefined, error.message);
    return new AppError('network', undefined, String(error));
  }
}
export const isAppError = (e) => e instanceof AppError;
