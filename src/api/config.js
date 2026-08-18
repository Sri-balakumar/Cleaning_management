import { rpc } from './rpcClient';

/**
 * Reading and writing the configuration: rounds, recording settings, who may
 * record, retention, and the AI review.
 *
 * Nothing here validates. Overlapping windows, a round with no weekday and
 * over-long durations are all refused by the server, which raises with a
 * message written for the person reading it. Re-checking any of that here would
 * only create a second set of rules to drift out of step.
 */

const call = (baseUrl, model, method, args, kwargs = {}) =>
  rpc(baseUrl, '/web/dataset/call_kw', { model, method, args, kwargs });

const CONFIG_FIELDS = [
  'id', 'name', 'timezone', 'slot_count',
  'duration_value', 'duration_unit', 'duration_seconds',
  'video_format', 'video_quality', 'camera_facing', 'estimated_size_mb',
  'allowed_user_mode', 'allowed_user_ids', 'upload_grace_seconds',
  'retention_number', 'retention_unit', 'retention_mode', 'max_upload_mb',
];

const SLOT_FIELDS = [
  'id', 'name', 'sequence', 'active', 'day_period',
  'hour_from', 'hour_to', 'duration_minutes',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'note',
];

const AI_CONFIG_FIELDS = [
  'id', 'name', 'enabled', 'provider', 'base_url', 'api_key', 'model',
  'frames_per_recording', 'max_output_tokens', 'timeout_seconds',
  'extra_instructions',
];

const AI_CHECK_FIELDS = ['id', 'sequence', 'active', 'name', 'description', 'weight'];

/** The company's configuration, or null when none has been set up. */
export async function fetchConfig(baseUrl) {
  const rows = await call(baseUrl, 'cleaning.config', 'search_read', [[], CONFIG_FIELDS], {
    limit: 1,
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export const writeConfig = (baseUrl, id, values) =>
  call(baseUrl, 'cleaning.config', 'write', [[id], values]);

export const fetchSlots = (baseUrl, configId) =>
  call(baseUrl, 'cleaning.slot', 'search_read', [[['config_id', '=', configId]], SLOT_FIELDS], {
    order: 'sequence, hour_from, id',
  });

export const createSlot = (baseUrl, values) =>
  call(baseUrl, 'cleaning.slot', 'create', [values]);

export const writeSlot = (baseUrl, id, values) =>
  call(baseUrl, 'cleaning.slot', 'write', [[id], values]);

/**
 * Deleting a round with recordings against it is refused by the `restrict`
 * rule on cleaning.recording.slot_id. That surfaces as a server error and is
 * shown as-is -- the caller must not report success.
 */
export const deleteSlot = (baseUrl, id) => call(baseUrl, 'cleaning.slot', 'unlink', [[id]]);

export async function fetchAiConfig(baseUrl) {
  const rows = await call(baseUrl, 'cleaning.ai.config', 'search_read', [[], AI_CONFIG_FIELDS], {
    limit: 1,
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export const writeAiConfig = (baseUrl, id, values) =>
  call(baseUrl, 'cleaning.ai.config', 'write', [[id], values]);

export const fetchAiChecks = (baseUrl, configId) =>
  call(baseUrl, 'cleaning.ai.check', 'search_read', [[['config_id', '=', configId]], AI_CHECK_FIELDS], {
    order: 'sequence, id',
  });

export const createAiCheck = (baseUrl, values) =>
  call(baseUrl, 'cleaning.ai.check', 'create', [values]);

export const writeAiCheck = (baseUrl, id, values) =>
  call(baseUrl, 'cleaning.ai.check', 'write', [[id], values]);

export const deleteAiCheck = (baseUrl, id) =>
  call(baseUrl, 'cleaning.ai.check', 'unlink', [[id]]);

/** For the allowed-recorders picker. Returns `[[id, "Name"], …]`. */
export const searchUsers = (baseUrl, term) =>
  call(baseUrl, 'res.users', 'name_search', [], { name: term || '', limit: 20 });

/** Names for ids already on the allowed list, so they render before searching. */
export const readUserNames = (baseUrl, ids) =>
  ids?.length ? call(baseUrl, 'res.users', 'read', [ids, ['id', 'name']]) : Promise.resolve([]);

// ---------------------------------------------------------------------------
// Times are floats on the server: 9.5 means 09:30.
// ---------------------------------------------------------------------------

/**
 * Mirrors the server's `float_to_time`, including how it carries: 9.999 must
 * become 10:00 rather than an invalid 9:60, and anything past the end of the
 * day clamps instead of wrapping into tomorrow.
 */
export function floatToHm(value) {
  const clamped = Math.max(0, Math.min(Number(value) || 0, 24));
  if (clamped >= 24) return { hour: 23, minute: 59 };
  let hour = Math.floor(clamped);
  let minute = Math.round((clamped - hour) * 60);
  if (minute === 60) {
    hour += 1;
    minute = 0;
  }
  return hour >= 24 ? { hour: 23, minute: 59 } : { hour, minute };
}

export const hmToFloat = (hour, minute) => Number(hour) + Number(minute) / 60;

/** "09:30" — the same shape the server puts in its own labels. */
export function formatFloatTime(value) {
  const { hour, minute } = floatToHm(value);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
