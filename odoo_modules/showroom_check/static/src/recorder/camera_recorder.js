import { browser } from "@web/core/browser/browser";

/**
 * Camera and MediaRecorder wrapper.
 *
 * Framework-free on purpose: no Odoo or OWL imports, so a test can build one
 * with a fake stream and drive it without rendering anything.
 *
 * The one rule this class exists to enforce: whatever happens - success, error,
 * cancellation, the page being closed - the camera gets switched off. Every
 * exit path leads to dispose(), and dispose() is safe to call twice.
 */
export class CameraRecorder {
    /**
     * @param {Object} config
     * @param {Object} config.constraints        from buildConstraints()
     * @param {string} config.mimeType           from resolveMimeType()
     * @param {number} config.videoBitsPerSecond
     * @param {number} config.durationSeconds    how long to record
     * @param {number} config.maxBytes           stop early rather than produce
     *                                           a file the server will refuse
     * @param {number} [config.timesliceMs=1000]
     * @param {Function} [config.onTick]         (elapsedSeconds, bytesSoFar)
     * @param {Function} [config.onStateChange]  (state)
     * @param {HTMLVideoElement} [config.videoElement] the on-screen preview,
     *        which stills are drawn from
     * @param {number} [config.frameCount=0] how many stills to take; 0 = none
     */
    constructor(config) {
        Object.assign(this, config);
        this.timesliceMs = config.timesliceMs || 1000;
        this.frameCount = config.frameCount || 0;
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.bytes = 0;
        this.startedAtPerf = 0;
        this.truncated = false;
        this.disposed = false;
        // Stills grabbed while recording. These are what an AI review
        // looks at later - a vision model reads pictures, not video, and
        // taking them here means known moments rather than wherever a
        // decoder would happen to land.
        this.frames = [];
        this._frameTimer = null;
        this.actualWidth = 0;
        this.actualHeight = 0;
        this._stopTimer = null;
        this._tickTimer = null;
        this._settle = null;
    }

    /**
     * Turn the camera on.
     *
     * Kept separate from run() so the page can show a live preview and let
     * somebody check they are in frame before anything is recorded.
     */
    async acquire() {
        if (this.disposed) {
            throw new Error("disposed");
        }
        this.stream = await browser.navigator.mediaDevices.getUserMedia(this.constraints);

        // The permission prompt can sit on screen for a long time, and the page
        // may well have been closed behind it. Without this check the camera
        // light stays on with nothing attached to it.
        if (this.disposed) {
            this.stream.getTracks().forEach((track) => track.stop());
            this.stream = null;
            throw new Error("disposed");
        }

        const [track] = this.stream.getVideoTracks();
        if (track && track.getSettings) {
            const settings = track.getSettings();
            this.actualWidth = settings.width || 0;
            this.actualHeight = settings.height || 0;
        }
        return this.stream;
    }

    /** @returns {Promise<{blob: Blob, seconds: number, truncated: boolean}>} */
    run() {
        return new Promise((resolve, reject) => {
            this._settle = { resolve, reject };

            let recorder;
            try {
                recorder = new MediaRecorder(this.stream, {
                    mimeType: this.mimeType,
                    videoBitsPerSecond: this.videoBitsPerSecond,
                });
            } catch {
                // Some builds accept a format when asked whether they support
                // it and then refuse it here. Recording in whatever the browser
                // picks is much better than losing the round entirely.
                recorder = new MediaRecorder(this.stream);
                this.mimeType = recorder.mimeType || "video/webm";
            }
            this.recorder = recorder;

            recorder.ondataavailable = (event) => {
                if (!event.data || !event.data.size) {
                    return;
                }
                this.chunks.push(event.data);
                this.bytes += event.data.size;

                // Size limit, checked as the data arrives. This is why the
                // recorder is started with a timeslice: without it there is only
                // one chunk, delivered at the end, and by then the oversized
                // file already exists.
                if (this.maxBytes && this.bytes >= this.maxBytes) {
                    this.truncated = true;
                    this.stop();
                    return;
                }
                // Backstop for the duration. This runs off the camera's own
                // data, not a timer, so it still fires if the browser has put
                // this tab's timers to sleep.
                if (this.elapsed() >= this.durationSeconds) {
                    this.stop();
                }
            };

            recorder.onerror = (event) => {
                const error = (event && event.error) || new Error("Recording failed");
                this.dispose();
                if (this._settle) {
                    this._settle.reject(error);
                    this._settle = null;
                }
            };

            recorder.onstop = () => {
                const seconds = this.elapsed();
                const blob = new Blob(this.chunks, { type: this.mimeType });
                this.chunks = [];
                const truncated = this.truncated;
                this.dispose();
                if (this._settle) {
                    this._settle.resolve({ blob, seconds, truncated });
                    this._settle = null;
                }
            };

            this.startedAtPerf = browser.performance.now();
            recorder.start(this.timesliceMs);
            if (this.onStateChange) {
                this.onStateChange("recording");
            }

            this._stopTimer = browser.setTimeout(
                () => this.stop(),
                this.durationSeconds * 1000
            );
            this._tickTimer = browser.setInterval(() => {
                if (this.onTick) {
                    this.onTick(this.elapsed(), this.bytes);
                }
            }, 250);

            if (this.frameCount > 0) {
                // Spread evenly across the recording, with the first taken a
                // moment in rather than at zero - the very first frame of a
                // camera stream is often still auto-exposing and comes out
                // black or washed out.
                const gap = (this.durationSeconds * 1000) / (this.frameCount + 1);
                let taken = 0;
                this._frameTimer = browser.setInterval(() => {
                    if (taken >= this.frameCount) {
                        browser.clearInterval(this._frameTimer);
                        this._frameTimer = null;
                        return;
                    }
                    taken++;
                    this.captureFrame();
                }, gap);
            }
        });
    }

    /**
     * Take one still from the live stream.
     *
     * Drawn from the video element rather than requested from the camera
     * separately, so it is exactly what was being recorded at that instant and
     * costs no extra camera access. JPEG at 0.8 keeps each frame around
     * 100-200 KB, which is small next to the video itself.
     */
    captureFrame() {
        const video = this.videoElement;
        if (!video || !video.videoWidth) {
            return; // not showing anything yet
        }
        try {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        this.frames.push(blob);
                    }
                },
                "image/jpeg",
                0.8
            );
        } catch {
            // A still is a nice-to-have. Never let it take the recording down.
        }
    }

    elapsed() {
        // performance.now() only ever moves forward, so a clock correction
        // part-way through cannot make the recording appear to jump.
        return this.startedAtPerf
            ? (browser.performance.now() - this.startedAtPerf) / 1000
            : 0;
    }

    /** Finish normally. Safe to call more than once. */
    stop() {
        // One last still before the stream goes away, so there is always a
        // picture of how the area was left.
        this.captureFrame();
        browser.clearTimeout(this._stopTimer);
        browser.clearInterval(this._tickTimer);
        browser.clearInterval(this._frameTimer);
        this._stopTimer = null;
        this._tickTimer = null;
        this._frameTimer = null;
        if (this.recorder && this.recorder.state !== "inactive") {
            this.recorder.stop(); // onstop finishes the job
        } else {
            this.dispose();
        }
    }

    /**
     * Throw the recording away.
     *
     * Clearing onstop BEFORE stopping is the whole point: otherwise the stop
     * handler still runs, still builds the file, and still hands it back to be
     * uploaded - so a cancelled recording gets saved anyway.
     */
    abort() {
        if (this.recorder) {
            this.recorder.onstop = null;
            this.recorder.ondataavailable = null;
            this.recorder.onerror = null;
        }
        this.chunks = [];
        this.dispose();
        if (this._settle) {
            this._settle.reject(new Error("aborted"));
            this._settle = null;
        }
    }

    /** Switch the camera off and release everything. Safe to call repeatedly. */
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        browser.clearTimeout(this._stopTimer);
        browser.clearInterval(this._tickTimer);
        browser.clearInterval(this._frameTimer);
        this._stopTimer = null;
        this._tickTimer = null;
        this._frameTimer = null;
        try {
            if (this.recorder && this.recorder.state !== "inactive") {
                this.recorder.stop();
            }
        } catch {
            // Already stopped.
        }
        this.recorder = null;
        if (this.stream) {
            // This is what turns the camera light off.
            this.stream.getTracks().forEach((track) => track.stop());
            this.stream = null;
        }
        if (this.onStateChange) {
            this.onStateChange("disposed");
        }
    }
}
