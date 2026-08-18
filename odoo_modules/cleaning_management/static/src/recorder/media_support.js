import { browser } from "@web/core/browser/browser";

// Everything in this file is a plain function with no framework involvement, so
// it can be tested directly without mounting anything.

/**
 * Is recording possible at all in this browser, on this page?
 *
 * `isSecureContext` is checked rather than the address, because localhost
 * counts as secure even over plain http - a developer working locally must not
 * be shown the "needs HTTPS" message.
 */
export function getCapabilities() {
    const secure = Boolean(window.isSecureContext);
    const hasMediaDevices = Boolean(
        browser.navigator.mediaDevices && browser.navigator.mediaDevices.getUserMedia
    );
    const hasRecorder = Boolean(
        window.MediaRecorder && typeof window.MediaRecorder.isTypeSupported === "function"
    );
    return {
        secure,
        hasMediaDevices,
        hasRecorder,
        supported: secure && hasMediaDevices && hasRecorder,
        // Which of the three failed, so the page can show the right message
        // instead of one vague "not supported".
        blocker: !secure
            ? "insecure_origin"
            : !hasMediaDevices
            ? "no_media_devices"
            : !hasRecorder
            ? "no_recorder"
            : false,
    };
}

/**
 * Pick a recording format this browser can actually produce.
 *
 * The server sends its preferred format first and the other one after it, so
 * walking the list in order gives the preference for free. Falling back rather
 * than refusing is deliberate: a WebM clip is infinitely more useful than no
 * clip, and the page says so when it happens.
 *
 * @param {string[]} candidates ordered mime types, preferred container first
 * @param {string} preferred "webm" | "mp4"
 * @returns {{mimeType: string, container: string, fellBack: boolean}|null}
 */
export function resolveMimeType(candidates, preferred = "webm") {
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) {
        return null;
    }
    for (const mimeType of candidates || []) {
        if (window.MediaRecorder.isTypeSupported(mimeType)) {
            const container = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
            return { mimeType, container, fellBack: container !== preferred };
        }
    }
    return null;
}

/**
 * The file extension must follow what was actually recorded, never what was
 * asked for. Naming a WebM file ".mp4" produces a file that will not open.
 */
export function extensionFor(mimeType) {
    return String(mimeType || "").startsWith("video/mp4") ? "mp4" : "webm";
}

/**
 * Build the camera request.
 *
 * Every value is "ideal", never "exact". "exact" makes the browser refuse
 * outright on any camera that cannot hit the number - including plenty of
 * 1080p-capable webcams asked for 1080p in poor light, where the driver quietly
 * drops the frame rate.
 */
export function buildConstraints(settings) {
    const video = {
        width: { ideal: settings.width || 1280 },
        height: { ideal: settings.height || 720 },
        frameRate: { ideal: settings.frame_rate || 24, max: settings.frame_rate || 24 },
    };
    if (settings.facing_mode) {
        // Also ideal: a desktop webcam reports no facing mode at all, and
        // demanding one would fail on every office PC.
        video.facingMode = { ideal: settings.facing_mode };
    }
    if (settings.deviceId) {
        video.deviceId = { ideal: settings.deviceId };
    }
    // Sound is never recorded: it keeps files small, avoids a second permission
    // prompt, and avoids capturing conversations happening around the camera.
    return { video, audio: false };
}

/** Rough size of a clip, for warning people before they commit to recording. */
export function estimateBytes(seconds, bitrate) {
    return Math.round(((bitrate || 2500000) / 8) * (seconds || 0));
}

export function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) {
        return `${value} B`;
    }
    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(0)} KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Seconds to `m:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
    }
    return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Whole seconds left, for the big countdown shown while recording.
 *
 * Floored rather than rounded: a tenth of a second into a 60 second recording
 * the true figure is 59.9, and flooring shows 59 immediately - which is how a
 * countdown is expected to behave. Rounding would display 60 for the first half
 * second and look stuck. Never negative, because the recorder can overrun very
 * slightly before the stop callback lands.
 */
export function wholeSecondsLeft(remainingSeconds) {
    return Math.max(0, Math.floor(remainingSeconds || 0));
}

/** Longer, friendlier form for a countdown that may be hours away. */
export function formatCountdown(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    if (seconds >= 3600) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }
    return formatDuration(seconds);
}

// ---------------------------------------------------------------------------
// Choosing a camera
//
// Which camera to use belongs to the COMPUTER, not to the company. Two
// recording stations have different hardware, so one company-wide setting would
// be wrong for at least one of them. Browsers also hand out a different
// deviceId per site and forget it when site data is cleared, so an id is not
// something worth storing on the server either.
//
// Hence: remember it here, in this browser, and match it back by the camera's
// name first (which is stable) before falling back to the id.
// ---------------------------------------------------------------------------

const PREFERRED_CAMERA_KEY = "cleaning_management.preferred_camera";

/** Cameras attached to this computer. */
export async function listCameras() {
    if (!browser.navigator.mediaDevices?.enumerateDevices) {
        return [];
    }
    let devices;
    try {
        devices = await browser.navigator.mediaDevices.enumerateDevices();
    } catch {
        return [];
    }
    return devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({
            deviceId: device.deviceId,
            // Browsers hide the name until the camera has been allowed once, so
            // before that we can only offer "Camera 1", "Camera 2"...
            label: device.label || `Camera ${index + 1}`,
            named: Boolean(device.label),
        }));
}

export function getPreferredCamera() {
    try {
        const raw = browser.localStorage.getItem(PREFERRED_CAMERA_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        // Unreadable or not valid JSON - fall back to the system default rather
        // than letting a stored value break the recorder.
        return null;
    }
}

export function setPreferredCamera(camera) {
    try {
        if (!camera) {
            browser.localStorage.removeItem(PREFERRED_CAMERA_KEY);
            return;
        }
        browser.localStorage.setItem(
            PREFERRED_CAMERA_KEY,
            JSON.stringify({ deviceId: camera.deviceId, label: camera.label })
        );
    } catch {
        // Private browsing refuses to store anything. Losing the preference is
        // an inconvenience; throwing here would stop somebody recording.
    }
}

/**
 * Work out which camera to open.
 *
 * By name first: ids change between visits, names do not. Returns null to mean
 * "let the system decide", which is the right answer when the remembered camera
 * has been unplugged.
 */
export function resolvePreferredDeviceId(cameras, preferred) {
    if (!preferred || !cameras?.length) {
        return null;
    }
    const byLabel = cameras.find(
        (camera) => camera.named && preferred.label && camera.label === preferred.label
    );
    if (byLabel) {
        return byLabel.deviceId;
    }
    const byId = cameras.find(
        (camera) => preferred.deviceId && camera.deviceId === preferred.deviceId
    );
    return byId ? byId.deviceId : null;
}

/**
 * The full support picture, for the diagnostics panel. Being able to ask
 * somebody for one screenshot instead of a conversation is worth the few lines.
 */
export function supportMatrix(candidates) {
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) {
        return {};
    }
    const result = {};
    for (const mimeType of candidates || []) {
        result[mimeType] = window.MediaRecorder.isTypeSupported(mimeType);
    }
    return result;
}
