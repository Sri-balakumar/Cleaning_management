import { Component, useState, onWillStart, onWillDestroy } from "@odoo/owl";
import { browser } from "@web/core/browser/browser";

import { listCameras } from "./media_support";

/**
 * A dropdown of the cameras attached to this computer.
 *
 * Presentational: it lists cameras and reports the choice upward. It never
 * opens a stream or saves anything itself - the dialog above it owns both.
 *
 * Not registered in any registry; wired in through `static components`.
 */
export class CameraPicker extends Component {
    static template = "cleaning_management.CameraPicker";
    static props = {
        selectedId: { type: [String, { value: null }], optional: true },
        onSelect: Function,
        disabled: { type: Boolean, optional: true },
    };

    setup() {
        this.state = useState({ cameras: [], loading: true });

        onWillStart(async () => {
            await this.refresh();
        });

        // Plugging in or removing a webcam should update the list without a
        // page reload. An AbortController is the tidiest way to be sure the
        // listener goes when the component does.
        this.abort = new AbortController();
        if (browser.navigator.mediaDevices?.addEventListener) {
            browser.navigator.mediaDevices.addEventListener(
                "devicechange",
                () => this.refresh(),
                { signal: this.abort.signal }
            );
        }
        onWillDestroy(() => this.abort.abort());
    }

    async refresh() {
        this.state.loading = true;
        this.state.cameras = await listCameras();
        this.state.loading = false;
    }

    onChange(event) {
        const deviceId = event.target.value;
        if (!deviceId) {
            this.props.onSelect(null);
            return;
        }
        const camera = this.state.cameras.find((c) => c.deviceId === deviceId);
        this.props.onSelect(camera || null);
    }

    /** True once the camera has been allowed and the names are readable. */
    get hasNames() {
        return this.state.cameras.some((camera) => camera.named);
    }
}
