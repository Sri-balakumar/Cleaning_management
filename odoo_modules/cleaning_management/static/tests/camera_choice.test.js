import { describe, expect, test } from "@odoo/hoot";
import { patchWithCleanup } from "@web/../tests/web_test_helpers";
import { browser } from "@web/core/browser/browser";

import {
    getPreferredCamera,
    listCameras,
    resolvePreferredDeviceId,
    setPreferredCamera,
} from "@cleaning_management/recorder/media_support";

describe.current.tags("headless");

/** A localStorage that actually stores, so a round trip can be checked. */
function withWorkingStorage() {
    const store = {};
    patchWithCleanup(browser, {
        localStorage: {
            getItem: (key) => (key in store ? store[key] : null),
            setItem: (key, value) => {
                store[key] = String(value);
            },
            removeItem: (key) => {
                delete store[key];
            },
        },
    });
    return store;
}

test("the chosen camera is remembered and read back", () => {
    withWorkingStorage();
    setPreferredCamera({ deviceId: "abc123", label: "Logitech C920" });
    expect(getPreferredCamera()).toEqual({
        deviceId: "abc123",
        label: "Logitech C920",
    });
});

test("clearing the choice returns to the system default", () => {
    withWorkingStorage();
    setPreferredCamera({ deviceId: "abc123", label: "Logitech C920" });
    setPreferredCamera(null);
    expect(getPreferredCamera()).toBe(null);
});

test("a storage that refuses to write does not stop anything", () => {
    // Private browsing throws on write. Losing the preference is a nuisance;
    // throwing here would stop somebody recording.
    patchWithCleanup(browser, {
        localStorage: {
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => {
                throw new Error("denied");
            },
            removeItem: () => {
                throw new Error("denied");
            },
        },
    });
    expect(() => setPreferredCamera({ deviceId: "x", label: "y" })).not.toThrow();
    expect(getPreferredCamera()).toBe(null);
});

test("corrupted stored data is ignored rather than breaking the recorder", () => {
    patchWithCleanup(browser, {
        localStorage: {
            getItem: () => "{not json",
            setItem: () => {},
            removeItem: () => {},
        },
    });
    expect(getPreferredCamera()).toBe(null);
});

test("only video inputs are listed, and unnamed cameras still get a label", async () => {
    patchWithCleanup(browser.navigator, {
        mediaDevices: {
            enumerateDevices: async () => [
                { kind: "audioinput", deviceId: "mic1", label: "Microphone" },
                { kind: "videoinput", deviceId: "cam1", label: "Integrated Webcam" },
                // Empty label: the browser hides names until the camera has
                // been allowed once.
                { kind: "videoinput", deviceId: "cam2", label: "" },
                { kind: "audiooutput", deviceId: "spk1", label: "Speakers" },
            ],
        },
    });
    const cameras = await listCameras();
    expect(cameras).toHaveLength(2);
    expect(cameras[0].label).toBe("Integrated Webcam");
    expect(cameras[0].named).toBe(true);
    expect(cameras[1].label).toBe("Camera 2");
    expect(cameras[1].named).toBe(false);
});

test("the remembered camera is matched by name, not by id", () => {
    // Browsers hand out a different deviceId per site and reset it when site
    // data is cleared, so the name is the part worth trusting.
    const cameras = [
        { deviceId: "new-id-after-reset", label: "Logitech C920", named: true },
        { deviceId: "other", label: "Integrated Webcam", named: true },
    ];
    const resolved = resolvePreferredDeviceId(cameras, {
        deviceId: "stale-id-from-last-time",
        label: "Logitech C920",
    });
    expect(resolved).toBe("new-id-after-reset");
});

test("falls back to the id when the name is not readable yet", () => {
    const cameras = [{ deviceId: "cam1", label: "Camera 1", named: false }];
    expect(
        resolvePreferredDeviceId(cameras, { deviceId: "cam1", label: "Old Name" })
    ).toBe("cam1");
});

test("an unplugged camera falls back to the system default", () => {
    const cameras = [{ deviceId: "cam1", label: "Integrated Webcam", named: true }];
    expect(
        resolvePreferredDeviceId(cameras, { deviceId: "gone", label: "USB Camera" })
    ).toBe(null);
    expect(resolvePreferredDeviceId([], { deviceId: "x", label: "y" })).toBe(null);
    expect(resolvePreferredDeviceId(cameras, null)).toBe(null);
});
