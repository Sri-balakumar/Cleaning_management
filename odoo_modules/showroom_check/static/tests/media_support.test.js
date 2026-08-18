import { describe, expect, test } from "@odoo/hoot";
import { patchWithCleanup } from "@web/../tests/web_test_helpers";

import {
    buildConstraints,
    estimateBytes,
    extensionFor,
    formatCountdown,
    formatDuration,
    resolveMimeType,
    wholeSecondsLeft,
} from "@showroom_check/recorder/media_support";

describe.current.tags("headless");

/** Pretend to be a browser that supports exactly the listed formats. */
function withSupportFor(supported) {
    patchWithCleanup(window, {
        MediaRecorder: Object.assign(function () {}, {
            isTypeSupported: (type) => supported.includes(type),
        }),
    });
}

const WEBM = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
const MP4 = ["video/mp4;codecs=avc1.42E01E", "video/mp4"];

test("picks the best format the browser supports", () => {
    withSupportFor(WEBM);
    const resolved = resolveMimeType([...WEBM, ...MP4], "webm");
    expect(resolved.mimeType).toBe("video/webm;codecs=vp9");
    expect(resolved.container).toBe("webm");
    expect(resolved.fellBack).toBe(false);
});

test("falls back rather than refusing when the chosen format is unavailable", () => {
    // Firefox-like: no MP4 recording at all, even though MP4 was asked for.
    withSupportFor(WEBM);
    const resolved = resolveMimeType([...MP4, ...WEBM], "mp4");
    expect(resolved.container).toBe("webm");
    expect(resolved.fellBack).toBe(true);
});

test("reports nothing usable when the browser can record no known format", () => {
    withSupportFor([]);
    expect(resolveMimeType([...WEBM, ...MP4], "webm")).toBe(null);
});

test("the file extension follows what was recorded, not what was asked for", () => {
    // A WebM file named .mp4 simply will not open - this is the guard for it.
    expect(extensionFor("video/webm;codecs=vp9")).toBe("webm");
    expect(extensionFor("video/mp4;codecs=avc1.42E01E")).toBe("mp4");
});

test("camera settings are never demanded exactly", () => {
    // "exact" makes the browser refuse outright on any camera that cannot hit
    // the number, which is a large share of real webcams.
    const constraints = buildConstraints({
        width: 1280,
        height: 720,
        frame_rate: 24,
        facing_mode: "environment",
    });
    const serialised = JSON.stringify(constraints);
    expect(serialised.includes("exact")).toBe(false);
    expect(constraints.video.width.ideal).toBe(1280);
    expect(constraints.audio).toBe(false);
});

test("size estimate matches the documented figures", () => {
    // 720p at 2.5 Mbps for 30 seconds is about 9.4 MB.
    const bytes = estimateBytes(30, 2500000);
    expect(Math.round(bytes / (1024 * 1024))).toBe(9);
});

test("durations read the way people expect", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3665)).toBe("1:01:05");
    expect(formatCountdown(8040)).toBe("2h 14m");
    expect(formatCountdown(65)).toBe("1:05");
});

test("the recording countdown shows whole seconds, counting down", () => {
    // A one-minute recording must read 59 the instant it starts, not linger on
    // 60 - that is what "1 minute means 59, 58, 57" describes.
    expect(wholeSecondsLeft(59.9)).toBe(59);
    expect(wholeSecondsLeft(59.1)).toBe(59);
    expect(wholeSecondsLeft(1.9)).toBe(1);
    expect(wholeSecondsLeft(0.4)).toBe(0);
});

test("the countdown never goes negative", () => {
    // The recorder can overrun by a fraction before the stop callback lands.
    expect(wholeSecondsLeft(-0.3)).toBe(0);
    expect(wholeSecondsLeft(-5)).toBe(0);
    expect(wholeSecondsLeft(undefined)).toBe(0);
    expect(wholeSecondsLeft(null)).toBe(0);
});
