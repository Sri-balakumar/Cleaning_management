import { rpc } from './rpcClient';

/**
 * The PDFs behind the Help screen, held in the database so a document can be
 * replaced without shipping a new build.
 *
 * The list arrives already filtered for whoever is signed in: the server drops
 * anything aimed at managers when the caller is not one, and refuses the bytes
 * again when a document is opened. Do NOT re-filter by `audience` here or in a
 * screen -- a second copy of that rule is a second chance for the two to
 * disagree, and only one of them is the one that counts.
 *
 * Each row carries `section`, which is the only thing the app decides: which of
 * the two headings on the Help screen it belongs under.
 */
function callKw(baseUrl, method, args = []) {
  return rpc(baseUrl, '/web/dataset/call_kw', {
    model: 'cleaning.manual',
    method,
    args,
    kwargs: {},
  });
}

/** Metadata only - `[{id, name, filename, section, audience}]` - so the list stays light. */
export function fetchManuals(baseUrl) {
  return callKw(baseUrl, 'get_manuals');
}

/** One document: `{id, name, filename, data}` with `data` base64, or `false`. */
export function fetchManual(baseUrl, manualId) {
  return callKw(baseUrl, 'get_manual', [manualId]);
}

/**
 * One document's guide: `{id, name, html, has_pdf}`, or `false`.
 *
 * `html` is the body alone. The screen supplies the shell, because the same
 * body is wrapped differently in the backend, where a button can simply open a
 * URL, and here, where it cannot.
 */
export function fetchGuide(baseUrl, manualId) {
  return callKw(baseUrl, 'get_guide', [manualId]);
}
