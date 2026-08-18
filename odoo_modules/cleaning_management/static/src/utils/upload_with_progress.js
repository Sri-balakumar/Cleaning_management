import { _t } from "@web/core/l10n/translation";

/**
 * Upload a file with a real progress bar.
 *
 * XMLHttpRequest rather than fetch, because it is the only one that reports
 * upload progress - and watching a bar move is the difference between waiting
 * patiently and reloading the page halfway through.
 *
 * Returns both the promise and the request, so the caller can cancel.
 *
 * @param {string} url
 * @param {FormData} formData
 * @param {Function} [onProgress]
 * @param {Object} [options]
 * @param {number} [options.stallMs=30000] give up after this long with no progress
 * @param {Function} [options.createXhr] injection point for tests
 * @returns {{promise: Promise<Object>, xhr: XMLHttpRequest}}
 */
export function uploadWithProgress(url, formData, onProgress, options = {}) {
    const stallMs = options.stallMs || 30000;
    const xhr = options.createXhr ? options.createXhr() : new XMLHttpRequest();
    let stallTimer = null;
    let finished = false;

    const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            if (!finished) {
                xhr.__stalled = true;
                xhr.abort();
            }
        }, stallMs);
    };

    const promise = new Promise((resolve, reject) => {
        xhr.open("POST", url, true);

        // Cross-site protection stays on for this route, so the token has to go
        // along with the file. It is a global provided by Odoo, not an import.
        formData.append("csrf_token", odoo.csrf_token);

        // No fixed timeout. A large recording on a slow connection can
        // legitimately take minutes, and cutting it off would destroy the
        // recording. What is watched for instead is a *stall* - no progress at
        // all - which is what a dead connection actually looks like.
        xhr.upload.onprogress = (event) => {
            armStall();
            if (event.lengthComputable && onProgress) {
                onProgress({
                    loaded: event.loaded,
                    total: event.total,
                    percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
                    // Everything has been sent but the server is still working.
                    // Saying so stops "it's stuck at 100%" being reported as a
                    // fault.
                    processing: event.loaded >= event.total,
                });
            }
        };

        xhr.onload = () => {
            finished = true;
            clearTimeout(stallTimer);
            if (xhr.status >= 200 && xhr.status < 300) {
                let payload;
                try {
                    payload = JSON.parse(xhr.responseText);
                } catch {
                    // A server error on this kind of route comes back as an
                    // HTML page, not JSON. Treating that as success would hide
                    // a real failure.
                    reject(new Error(_t("The server sent back an unexpected response.")));
                    return;
                }
                resolve(payload);
            } else if (xhr.status === 413) {
                // Refused before reaching our code, so there is no JSON message
                // to read - the status is all there is to go on.
                reject(
                    new Error(
                        _t(
                            "This recording is too large for the server to accept. Ask your administrator to shorten the recording length or lower the video quality."
                        )
                    )
                );
            } else if (xhr.status === 401 || xhr.status === 403) {
                let message = "";
                try {
                    message = (JSON.parse(xhr.responseText) || {}).message || "";
                } catch {
                    message = "";
                }
                reject(
                    new Error(
                        message ||
                            _t("You are not allowed to save this recording, or your session has expired. Reload the page and sign in again.")
                    )
                );
            } else {
                reject(new Error(_t("Upload failed (error %s).", xhr.status)));
            }
        };

        xhr.onerror = () => {
            finished = true;
            clearTimeout(stallTimer);
            reject(new Error(_t("The connection was lost while uploading.")));
        };

        xhr.onabort = () => {
            finished = true;
            clearTimeout(stallTimer);
            reject(new Error(xhr.__stalled ? "stalled" : "aborted"));
        };

        armStall();
        xhr.send(formData);
    });

    return { promise, xhr };
}
