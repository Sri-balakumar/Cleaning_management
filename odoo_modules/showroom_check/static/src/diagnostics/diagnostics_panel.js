import { Component, useState, onWillStart } from "@odoo/owl";
import { browser } from "@web/core/browser/browser";

import {
    getCapabilities,
    resolveMimeType,
    supportMatrix,
} from "../recorder/media_support";

/**
 * A plain dump of what this browser can actually do.
 *
 * Exists so that "the camera doesn't work" can be answered with one screenshot
 * instead of a long conversation. Only shown in developer mode.
 */
export class DiagnosticsPanel extends Component {
    static template = "showroom_check.DiagnosticsPanel";
    static props = {
        settings: { type: Object, optional: true },
    };

    setup() {
        this.state = useState({
            cameras: [],
            permission: "unknown",
        });

        const settings = this.props.settings || {};
        this.capabilities = getCapabilities();
        this.matrix = supportMatrix(settings.mimetype_candidates || []);
        this.resolved = resolveMimeType(
            settings.mimetype_candidates || [],
            settings.format || "webm"
        );

        onWillStart(async () => {
            if (browser.navigator.mediaDevices?.enumerateDevices) {
                try {
                    const devices = await browser.navigator.mediaDevices.enumerateDevices();
                    this.state.cameras = devices
                        .filter((device) => device.kind === "videoinput")
                        // The label is empty until permission has been granted
                        // once - which is itself a useful thing to see here.
                        .map((device) => device.label || "(name hidden until allowed)");
                } catch {
                    this.state.cameras = [];
                }
            }
            if (browser.navigator.permissions?.query) {
                try {
                    const status = await browser.navigator.permissions.query({
                        name: "camera",
                    });
                    this.state.permission = status.state;
                } catch {
                    this.state.permission = "not reported by this browser";
                }
            }
        });
    }

    get origin() {
        return browser.location.origin;
    }

    get userAgent() {
        return browser.navigator.userAgent;
    }

    get matrixEntries() {
        return Object.entries(this.matrix);
    }
}
