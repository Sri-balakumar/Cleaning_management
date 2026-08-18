import { describe, expect, test } from "@odoo/hoot";
import { patchWithCleanup } from "@web/../tests/web_test_helpers";
import { browser } from "@web/core/browser/browser";

import { CameraRecorder } from "@cleaning_management/recorder/camera_recorder";

describe.current.tags("headless");

/** A stream whose tracks record whether they were stopped. */
function makeFakeStream() {
    const track = {
        stopped: false,
        stop() {
            this.stopped = true;
        },
        getSettings: () => ({ width: 1280, height: 720 }),
    };
    return {
        track,
        getTracks: () => [track],
        getVideoTracks: () => [track],
    };
}

/** A MediaRecorder that does nothing until the test tells it to. */
function installFakeRecorder() {
    const instances = [];
    patchWithCleanup(window, {
        MediaRecorder: Object.assign(
            function (stream, options) {
                this.stream = stream;
                this.mimeType = (options && options.mimeType) || "video/webm";
                this.state = "inactive";
                this.start = () => {
                    this.state = "recording";
                };
                this.stop = () => {
                    this.state = "inactive";
                    if (this.onstop) {
                        this.onstop();
                    }
                };
                this.emit = (size) => {
                    if (this.ondataavailable) {
                        this.ondataavailable({ data: new Blob([new Uint8Array(size)]) });
                    }
                };
                instances.push(this);
            },
            { isTypeSupported: () => true }
        ),
    });
    return instances;
}

function makeRecorder(stream, overrides = {}) {
    const recorder = new CameraRecorder({
        constraints: { video: true, audio: false },
        mimeType: "video/webm",
        videoBitsPerSecond: 2500000,
        durationSeconds: 60,
        maxBytes: 10000,
        ...overrides,
    });
    recorder.stream = stream;
    return recorder;
}

test("the camera is released when the recording finishes", async () => {
    const instances = installFakeRecorder();
    const stream = makeFakeStream();
    const recorder = makeRecorder(stream);

    const promise = recorder.run();
    instances[0].emit(100);
    instances[0].stop();

    const result = await promise;
    expect(result.blob).toBeInstanceOf(Blob);
    expect(stream.track.stopped).toBe(true);
});

test("recording stops early rather than producing a file the server will refuse", async () => {
    const instances = installFakeRecorder();
    const stream = makeFakeStream();
    const recorder = makeRecorder(stream, { maxBytes: 500 });

    const promise = recorder.run();
    instances[0].emit(600); // over the limit in one go

    const result = await promise;
    expect(result.truncated).toBe(true);
    expect(stream.track.stopped).toBe(true);
});

test("cancelling does not hand back a recording to upload", async () => {
    installFakeRecorder();
    const stream = makeFakeStream();
    const recorder = makeRecorder(stream);

    const promise = recorder.run();
    recorder.abort();

    await expect(promise).rejects.toThrow(/aborted/);
    expect(stream.track.stopped).toBe(true);
});

test("releasing the camera twice is harmless", () => {
    const stream = makeFakeStream();
    const recorder = makeRecorder(stream);
    recorder.dispose();
    recorder.dispose();
    expect(stream.track.stopped).toBe(true);
});

test("the camera is released even if the page closed while permission was pending", async () => {
    // This is the leak that leaves the camera light on with nothing on screen:
    // the permission prompt is answered after the page has already gone.
    const stream = makeFakeStream();
    let release;
    patchWithCleanup(browser.navigator, {
        mediaDevices: {
            getUserMedia: () => new Promise((resolve) => (release = resolve)),
        },
    });

    const recorder = new CameraRecorder({
        constraints: { video: true, audio: false },
        mimeType: "video/webm",
        durationSeconds: 60,
    });

    const pending = recorder.acquire();
    recorder.dispose(); // the page goes away
    release(stream); // and only then is permission granted

    await expect(pending).rejects.toThrow(/disposed/);
    expect(stream.track.stopped).toBe(true);
});
