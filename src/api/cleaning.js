import { Platform } from 'react-native';
import { AppError } from './errors';
import { getSessionCookie, rpc } from './rpcClient';

/**
 * Cleaning rounds: today's schedule, uploading a clip, and reading back what
 * was recorded.
 *
 * Deliberately thin. The server already decides who may record, when a window
 * is open, and who may read which recording -- this layer moves data and does
 * not re-implement any of those rules.
 */

/** Everything the rounds screen needs, in one call. */
export function getDashboardState(baseUrl) {
  return rpc(baseUrl, '/web/dataset/call_kw', {
    model: 'cleaning.config',
    method: 'get_dashboard_state',
    args: [],
    kwargs: {},
  });
}

/**
 * The upload route is a form post and keeps its cross-site protection, so it
 * needs a token. A browser reads one out of the page; we ask for it.
 */
export async function getUploadToken(baseUrl) {
  const result = await rpc(baseUrl, '/cleaning_management/app/token', {});
  const token = result?.csrf_token;
  if (!token) throw new AppError('server', 'The server did not return an upload token.');
  return token;
}

/**
 * Recordings the signed-in user is allowed to see.
 *
 * No role filtering here on purpose: record rules already scope a regular user
 * to their own recordings and let a manager see all of them. Repeating that
 * client-side is how the two versions drift apart.
 */
export function fetchRecordings(baseUrl, { limit = 80, domain = [] } = {}) {
  return rpc(baseUrl, '/web/dataset/call_kw', {
    model: 'cleaning.recording',
    method: 'search_read',
    args: [
      domain,
      ['id', 'slot_id', 'slot_date', 'user_id', 'started_at', 'duration_seconds',
       'file_format', 'file_size_mb', 'truncated', 'ai_status'],
    ],
    kwargs: { limit, order: 'slot_date desc, id desc' },
  });
}

export const videoUrl = (baseUrl, recordingId) =>
  `${baseUrl}/cleaning_management/video/${recordingId}`;

/** Headers needed to stream a protected video from the player. */
export function videoHeaders() {
  const cookie = getSessionCookie();
  return Platform.OS !== 'web' && cookie ? { Cookie: `session_id=${cookie}` } : {};
}

/** Odoo stores naive UTC: "YYYY-MM-DD HH:MM:SS". */
export function toServerDatetime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * Send one recorded clip.
 *
 * Uses XMLHttpRequest rather than fetch purely for `upload.onprogress` -- fetch
 * exposes no upload progress, and a minute of video over office wifi is far too
 * long to show nothing. The stills go alongside as `frame_N`; the server reads
 * any number of them and uses them for its review.
 */
export function uploadRecording(baseUrl, payload, onProgress) {
  const {
    slotId,
    csrfToken,
    videoUri,
    mimetype,
    fileFormat,
    startedAt,
    endedAt,
    durationSeconds,
    width,
    height,
    truncated,
    latitude,
    longitude,
    frames = [],
  } = payload;

  const form = new FormData();
  form.append('csrf_token', csrfToken);
  form.append('slot_id', String(slotId));
  form.append('started_at', toServerDatetime(startedAt));
  form.append('ended_at', toServerDatetime(endedAt));
  form.append('duration_seconds', String(Math.round(durationSeconds)));
  form.append('width', String(width || 0));
  form.append('height', String(height || 0));
  form.append('mimetype', mimetype);
  form.append('file_format', fileFormat);
  form.append('truncated', truncated ? '1' : '0');
  form.append('latitude', String(latitude || 0));
  form.append('longitude', String(longitude || 0));
  form.append('capture_mode', 'mobile');
  form.append('video', {
    uri: videoUri,
    name: `round.${fileFormat}`,
    type: mimetype,
  });
  frames.forEach((uri, index) => {
    form.append(`frame_${index}`, {
      uri,
      name: `frame_${index}.jpg`,
      type: 'image/jpeg',
    });
  });

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${baseUrl}/cleaning_management/upload`);

    const cookie = getSessionCookie();
    if (Platform.OS !== 'web' && cookie) {
      request.setRequestHeader('Cookie', `session_id=${cookie}`);
    }

    if (request.upload && onProgress) {
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total);
        }
      };
    }

    request.onload = () => {
      let body;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        reject(new AppError('server', 'The server sent back a reply the app could not read.'));
        return;
      }
      // This route reports refusals in the body with ok:false, and uses the
      // status code as well -- so the body is what decides.
      if (body?.ok) {
        resolve(body);
      } else {
        reject(new AppError('server', body?.message || 'The recording was not accepted.'));
      }
    };

    request.onerror = () =>
      reject(new AppError('network', 'The recording could not be sent. Check your connection.'));
    request.ontimeout = () => reject(new AppError('timeout'));
    request.onabort = () => reject(new AppError('network', 'The upload was cancelled.'));

    request.send(form);
  });
}
