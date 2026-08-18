import { rpc } from './rpcClient';

/**
 * The user-manual PDFs, held in the database so they can be replaced without
 * shipping a new build.
 *
 * Both calls are plain model access against a separate module. When that module
 * is not installed the RPC errors, and the caller is expected to treat that as
 * "there are no manuals" rather than as a failure worth showing anyone.
 */
function callKw(baseUrl, method, args = []) {
  return rpc(baseUrl, '/web/dataset/call_kw', {
    model: 'app.user.manual',
    method,
    args,
    kwargs: {},
  });
}

/** Metadata only - `[{id, name, filename}]` - so the list stays light. */
export function fetchManuals(baseUrl) {
  return callKw(baseUrl, 'get_manuals');
}

/** One document: `{id, name, filename, data}` with `data` base64, or `false`. */
export function fetchManual(baseUrl, manualId) {
  return callKw(baseUrl, 'get_manual', [manualId]);
}
