import {
    Component,
    useState,
    useRef,
    useEffect,
    onMounted,
    onWillUnmount,
    useExternalListener,
} from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";

import { CameraRecorder } from "./camera_recorder";
import { CameraPicker } from "./camera_picker";
import {
    buildConstraints,
    estimateBytes,
    extensionFor,
    formatBytes,
    formatDuration,
    getPreferredCamera,
    listCameras,
    resolveMimeType,
    resolvePreferredDeviceId,
    wholeSecondsLeft,
    setPreferredCamera,
} from "./media_support";
import { uploadWithProgress } from "../utils/upload_with_progress";

export class RecorderDialog extends Component {
    static template = "cleaning_management.RecorderDialog";
    static components = { Dialog, CameraPicker };
    static props = {
        // In test mode there is no round: the dialog only proves the camera
        // works. Nothing is recorded, nothing is uploaded, and the day's real
        // recording is left untouched.
        slot: { type: Object, optional: true },
        settings: Object,
        close: Function,
        testMode: { type: Boolean, optional: true },
        onRecorded: { type: Function, optional: true },
    };

    setup() {
        this.videoRef = useRef("preview");
        this.recorder = null;
        this.blob = null;
        this.currentXhr = null;
        this.localUrl = null;
        this.mimeType = null;
        // Set synchronously, unlike anything that has to wait for the camera.
        // Without it a double click starts a second camera before the first has
        // finished opening.
        this._starting = false;

        this.state = useState({
            phase: "requesting_camera",
            error: "",
            fellBack: false,
            elapsed: 0,
            remaining: this.props.settings.duration_seconds,
            bytes: 0,
            progress: 0,
            loaded: 0,
            total: 0,
            retryable: false,
            wasHidden: false,
            recordingId: false,
            truncated: false,
            streamGeneration: 0,
            // Which camera is in use. null means "whatever the system picks".
            selectedDeviceId: null,
            actualWidth: 0,
            actualHeight: 0,
        });

        this.estimatedBytes = estimateBytes(
            this.props.settings.duration_seconds,
            this.props.settings.video_bitrate
        );

        onMounted(() => this.acquireCamera());

        // The video element does not exist while the camera is still being
        // asked for - it only appears once the phase changes. Attaching the
        // stream here means it is connected the moment the element shows up,
        // whichever order those two things happen in.
        useEffect(
            (element) => {
                if (element && this.recorder && this.recorder.stream) {
                    element.srcObject = this.recorder.stream;
                }
            },
            // The stream counter matters for "try again": the element is
            // already on screen and unchanged, so without it a second attempt
            // would leave the new camera feed unattached.
            () => [this.videoRef.el, this.state.streamGeneration]
        );

        onWillUnmount(() => {
            // Last line of defence for the camera light.
            if (this.recorder) {
                this.recorder.dispose();
            }
            if (this.currentXhr) {
                this.currentXhr.abort();
            }
            if (this.localUrl) {
                URL.revokeObjectURL(this.localUrl);
                this.localUrl = null;
            }
            if (this._originalTitle !== undefined) {
                document.title = this._originalTitle;
            }
        });

        // Only while something would actually be lost. A page that always
        // objects to being closed is an irritation.
        useExternalListener(window, "beforeunload", (event) => {
            if (["recording", "uploading", "processing"].includes(this.state.phase)) {
                event.preventDefault();
                event.returnValue = "";
            }
        });

        useExternalListener(document, "visibilitychange", () => {
            if (document.hidden && this.state.phase === "recording") {
                this.state.wasHidden = true;
            }
        });
    }

    // ------------------------------------------------------------------
    // Camera
    // ------------------------------------------------------------------
    async acquireCamera() {
        const settings = this.props.settings;
        const resolved = resolveMimeType(settings.mimetype_candidates, settings.format);
        if (!resolved) {
            this.state.phase = "camera_missing";
            this.state.error = _t(
                "This browser cannot record video. Please use Google Chrome or Microsoft Edge on this computer."
            );
            return;
        }
        this.mimeType = resolved.mimeType;
        this.state.fellBack = resolved.fellBack;
        this.container = resolved.container;

        // Reuse the camera chosen on this computer last time, if it is still
        // plugged in. Names are only readable after the camera has been allowed
        // once, so the first ever run falls back to the system default and the
        // list fills in properly from then on.
        // A flag, not a null check on the id: null is itself a valid choice
        // meaning "use the system default", and a null check would keep
        // overriding that with the remembered camera.
        if (!this._cameraResolved) {
            const cameras = await listCameras();
            this.state.selectedDeviceId = resolvePreferredDeviceId(
                cameras,
                getPreferredCamera()
            );
            this._cameraResolved = true;
        }

        this.recorder = new CameraRecorder({
            constraints: buildConstraints({
                ...settings,
                deviceId: this.state.selectedDeviceId || undefined,
            }),
            mimeType: resolved.mimeType,
            videoBitsPerSecond: settings.video_bitrate,
            durationSeconds: settings.duration_seconds,
            maxBytes: settings.max_upload_bytes,
            timesliceMs: settings.timeslice_ms || 1000,
            // Stills for the AI review. The recorder draws them from the
            // preview that is already on screen; 0 means AI review is off,
            // in which case none are taken and nothing extra is uploaded.
            frameCount: this.props.testMode ? 0 : (settings.ai_frames || 0),
            videoElement: this.videoRef.el,
            onTick: (elapsed, bytes) => {
                this.state.elapsed = elapsed;
                this.state.remaining = Math.max(0, settings.duration_seconds - elapsed);
                this.state.bytes = bytes;
                // Same plain number as on screen, so a backgrounded tab still
                // shows how long is left.
                document.title = `● ${Math.floor(this.state.remaining)} - ${_t("Recording")}`;
            },
        });

        this.state.phase = "requesting_camera";
        try {
            await this.recorder.acquire();
            this.state.actualWidth = this.recorder.actualWidth;
            this.state.actualHeight = this.recorder.actualHeight;
            // Changing the phase is what puts the video element on screen; the
            // effect above then connects the camera to it.
            this.state.streamGeneration++;
            this.state.phase = "preview_ready";
        } catch (error) {
            this.handleCameraError(error);
        }
    }

    handleCameraError(error) {
        const name = (error && error.name) || "";
        if (name === "NotAllowedError" || name === "SecurityError") {
            this.state.phase = "camera_denied";
            this.state.error = _t(
                "Camera access was blocked. Click the camera icon in the address bar at the top of this window, choose Allow, then try again."
            );
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
            this.state.phase = "camera_missing";
            this.state.error = _t(
                "No camera was found on this computer. Plug one in, or ask IT to check the built-in camera."
            );
        } else if (name === "NotReadableError" || name === "TrackStartError") {
            // Far and away the most common one in an office.
            this.state.phase = "camera_busy";
            this.state.error = _t(
                "The camera is already being used by another program. Close Teams, Zoom or any other video app, then try again."
            );
        } else if (name === "OverconstrainedError") {
            this.state.phase = "camera_missing";
            this.state.error = _t(
                "This camera cannot record at the quality that has been set. Ask your administrator to choose a lower video quality."
            );
        } else if (error && error.message === "disposed") {
            // The dialog was closed while the permission prompt was open.
            return;
        } else {
            this.state.phase = "camera_missing";
            this.state.error =
                (error && error.message) || _t("The camera could not be started.");
        }
    }

    async retryCamera() {
        if (this.recorder) {
            this.recorder.dispose();
            this.recorder = null;
        }
        await this.acquireCamera();
    }

    /**
     * Switch to a different camera.
     *
     * Only offered before recording starts - swapping mid-recording would mean
     * two different views in one file.
     */
    async selectCamera(camera) {
        if (this.state.phase === "recording" || this.state.phase === "uploading") {
            return;
        }
        setPreferredCamera(camera);
        this.state.selectedDeviceId = camera ? camera.deviceId : null;
        // Already resolved by an explicit choice - do not let acquireCamera()
        // look the remembered one up again and undo it.
        this._cameraResolved = true;
        if (this.recorder) {
            this.recorder.dispose();
            this.recorder = null;
        }
        await this.acquireCamera();
    }

    // ------------------------------------------------------------------
    // Recording
    // ------------------------------------------------------------------
    async startRecording() {
        if (this._starting || this.state.phase !== "preview_ready") {
            return;
        }
        this._starting = true;
        // The preview element did not exist when the recorder was built, so
        // point it at the one now on screen before any stills are taken.
        if (this.recorder) {
            this.recorder.videoElement = this.videoRef.el;
        }
        this._originalTitle = document.title;
        this.state.phase = "recording";
        // Captured now, so the start time sent to the server is when recording
        // actually began rather than when the upload happened to start.
        this._startedAtMs = Date.now();
        try {
            const result = await this.recorder.run();
            this.state.phase = "stopping";
            this.blob = result.blob;
            await this.uploadClip(result.blob, result.seconds, result.truncated);
        } catch (error) {
            if (error && error.message === "aborted") {
                this.props.close();
                return;
            }
            this.state.phase = "failed_upload";
            this.state.retryable = false;
            this.state.error =
                (error && error.message) || _t("The recording failed.");
        } finally {
            this._starting = false;
            if (this._originalTitle !== undefined) {
                document.title = this._originalTitle;
            }
        }
    }

    stopEarly() {
        if (this.recorder && this.state.phase === "recording") {
            this.recorder.stop();
        }
    }

    discard() {
        if (this.recorder) {
            this.recorder.abort();
        }
        this.props.close();
    }

    // ------------------------------------------------------------------
    // Upload
    // ------------------------------------------------------------------
    buildFormData(blob, seconds, truncated) {
        const extension = extensionFor(this.mimeType);
        const filename = `cleaning_${this.props.slot.id}_${Date.now()}.${extension}`;
        const file = new File([blob], filename, { type: this.mimeType });

        const formData = new FormData();
        formData.append("slot_id", String(this.props.slot.id));
        formData.append("started_at", this.serverStartedAt());
        formData.append("ended_at", this.serverNowString());
        formData.append("duration_seconds", String(Math.round(seconds)));
        formData.append("mimetype", this.mimeType);
        formData.append("file_format", this.container);
        formData.append("truncated", truncated ? "1" : "0");
        formData.append("width", String(this.recorder ? this.recorder.actualWidth : 0));
        formData.append("height", String(this.recorder ? this.recorder.actualHeight : 0));
        // Appended exactly once, under the name the controller reads. Adding it
        // twice would send the whole recording twice over.
        formData.append("video", file, filename);

        // Stills for the AI review, named so the server keeps them in order.
        const frames = (this.recorder && this.recorder.frames) || [];
        frames.forEach((frame, index) => {
            const name = `frame_${String(index + 1).padStart(2, "0")}.jpg`;
            formData.append(name, frame, name);
        });
        return formData;
    }

    /**
     * Timestamps are sent in the SERVER's clock, not this computer's.
     *
     * The server checks the start time against the round's window, so a
     * computer whose clock is a few minutes out would otherwise have perfectly
     * good recordings refused.
     */
    serverStartedAt() {
        const offsetMs = (this.props.settings.serverOffsetMs || 0);
        const startedMs = this._startedAtMs || Date.now();
        return new Date(startedMs + offsetMs).toISOString().slice(0, 19).replace("T", " ");
    }

    serverNowString() {
        const offsetMs = (this.props.settings.serverOffsetMs || 0);
        return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
    }

    async uploadClip(blob, seconds, truncated) {
        this.state.phase = "uploading";
        this.state.progress = 0;
        this._lastClip = { blob, seconds, truncated };

        const { promise, xhr } = uploadWithProgress(
            this.props.settings.upload_url,
            this.buildFormData(blob, seconds, truncated),
            (progress) => {
                this.state.progress = progress.percent;
                this.state.loaded = progress.loaded;
                this.state.total = progress.total;
                this.state.phase = progress.processing ? "processing" : "uploading";
            }
        );
        this.currentXhr = xhr;

        try {
            const result = await promise;
            this.currentXhr = null;
            if (result && result.ok) {
                this.state.phase = "success";
                this.state.recordingId = result.recording_id;
                this.state.truncated = truncated;
                this.blob = null;
                if (this.props.onRecorded) {
                    this.props.onRecorded(result.state);
                }
            } else {
                // The server said no for a reason it can explain - trying again
                // would fail in exactly the same way.
                this.state.phase = "failed_rejected";
                this.state.retryable = false;
                this.state.error =
                    (result && result.message) ||
                    _t("The server did not accept this recording.");
            }
        } catch (error) {
            this.currentXhr = null;
            if (error && error.message === "aborted") {
                this.state.phase = "failed_upload";
                this.state.retryable = true;
                this.state.error = _t("Upload cancelled. The recording is still here.");
                return;
            }
            this.state.phase = "failed_upload";
            this.state.retryable = true;
            this.state.error = (error && error.message) || _t("Upload failed.");
        }
    }

    async retryUpload() {
        if (!this._lastClip) {
            return;
        }
        const { blob, seconds, truncated } = this._lastClip;
        await this.uploadClip(blob, seconds, truncated);
    }

    cancelUpload() {
        if (this.currentXhr) {
            this.currentXhr.abort();
        }
    }

    /**
     * Let somebody save the file themselves when the upload will not go
     * through. Losing the only copy of a recording is the worst outcome
     * available, and this costs almost nothing to offer.
     */
    downloadClip() {
        if (!this.blob && this._lastClip) {
            this.blob = this._lastClip.blob;
        }
        if (!this.blob) {
            return;
        }
        if (this.localUrl) {
            URL.revokeObjectURL(this.localUrl);
        }
        this.localUrl = URL.createObjectURL(this.blob);
        const link = document.createElement("a");
        link.href = this.localUrl;
        link.download = `cleaning_${this.props.slot.name || "round"}.${extensionFor(
            this.mimeType
        )}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // ------------------------------------------------------------------
    // Display helpers
    // ------------------------------------------------------------------
    /**
     * Whole seconds left, as a plain number for the on-screen countdown.
     *
     * Floored, not rounded. A tenth of a second into a 60 second recording the
     * real figure is 59.9; flooring shows 59 straight away, which is how a
     * countdown is expected to read. Rounding would sit on 60 for half a second
     * before moving, which looks stuck.
     */
    get secondsLeft() {
        return wholeSecondsLeft(this.state.remaining);
    }

    get isBusy() {
        return ["recording", "uploading", "processing", "stopping"].includes(
            this.state.phase
        );
    }

    /**
     * Whether the live camera element should be on screen.
     *
     * Preview and recording deliberately share one element - see the template.
     */
    get showsCamera() {
        return ["preview_ready", "recording", "stopping"].includes(this.state.phase);
    }

    /**
     * The camera chooser is offered before recording starts, and also when the
     * camera failed - "that one is busy, try the other" is a real fix.
     */
    get showsPicker() {
        return ["preview_ready", "camera_busy", "camera_missing"].includes(
            this.state.phase
        );
    }

    get title() {
        if (this.props.testMode) {
            return _t("Test camera");
        }
        return (this.props.slot && this.props.slot.name) || _t("Record");
    }

    /** True once the camera is up in test mode, i.e. the test has passed. */
    get testPassed() {
        return this.props.testMode && this.state.phase === "preview_ready";
    }

    /** What the camera actually gave us, which is often not what was asked for. */
    get resolutionLabel() {
        if (!this.state.actualWidth || !this.state.actualHeight) {
            return _t("unknown");
        }
        return `${this.state.actualWidth} x ${this.state.actualHeight}`;
    }

    get requestedResolutionLabel() {
        const settings = this.props.settings;
        return `${settings.width} x ${settings.height}`;
    }

    get resolutionMatches() {
        return (
            this.state.actualWidth === this.props.settings.width &&
            this.state.actualHeight === this.props.settings.height
        );
    }

    get formatLabel() {
        return this.mimeType || _t("unknown");
    }

    get estimateLabel() {
        return formatBytes(this.estimatedBytes);
    }

    formatDuration(seconds) {
        return formatDuration(seconds);
    }

    formatBytes(bytes) {
        return formatBytes(bytes);
    }

    onDialogClose() {
        if (this.isBusy) {
            return; // guarded in the template too
        }
        this.props.close();
    }
}
