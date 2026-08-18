/**
 * Every failure the network layer can produce, reduced to a small set of kinds
 * the UI can branch on. `message` is always safe to show to a user as-is.
 *
 * Kinds: 'invalid_url' | 'network' | 'timeout' | 'incompatible' |
 * 'invalid_credentials' | 'session_expired' | 'access_error' | 'server'
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
  server: 'The server returned an error.',
};
export class AppError extends Error {
  constructor(kind, message, detail) {
    super(message || DEFAULT_MESSAGES[kind]);
    this.name = 'AppError';
    this.kind = kind;
    this.detail = detail;
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
