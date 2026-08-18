import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { browser } from "@web/core/browser/browser";

import { useSlotClock } from "./use_slot_clock";
import { SlotCard } from "./slot_card";
import { RecorderDialog } from "../recorder/recorder_dialog";
import { DiagnosticsPanel } from "../diagnostics/diagnostics_panel";
import { getCapabilities } from "../recorder/media_support";

export class CleaningDashboard extends Component {
    static template = "showroom_check.CleaningDashboard";
    static components = { SlotCard, DiagnosticsPanel };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.capabilities = getCapabilities();
        this.ui = useState({ showDiagnostics: false });

        this.clock = useSlotClock(() =>
            this.orm.call("cleaning.config", "get_dashboard_state", [])
        );
    }

    get state() {
        return this.clock.state;
    }

    get data() {
        return this.clock.state.data || {};
    }

    get slots() {
        return this.data.slots || [];
    }

    get activeSlot() {
        return this.data.active_slot || null;
    }

    /**
     * How far this computer's clock is from the server's.
     *
     * Timestamps sent back with a recording are shifted by this, so a machine
     * whose clock is a few minutes out does not have perfectly good recordings
     * refused for being outside the window.
     */
    get serverOffsetMs() {
        if (!this.data.server_now_ts) {
            return 0;
        }
        return this.data.server_now_ts * 1000 - Date.now();
    }

    get currentOrigin() {
        return browser.location.origin;
    }

    countdownFor(slot) {
        return (this.state.countdowns || {})[slot.id];
    }

    isPending(slot) {
        return Boolean((this.state.pending || {})[slot.id]);
    }

    canRecord(slot) {
        return Boolean(
            this.capabilities.supported &&
                this.data.is_allowed &&
                slot.state === "open" &&
                !slot.recording_id &&
                !this.isPending(slot)
        );
    }

    blockedMessage(slot) {
        if (!this.capabilities.supported) {
            return "Recording is not available in this browser.";
        }
        if (!this.data.is_allowed) {
            return this.data.deny_message || "You are not allowed to record.";
        }
        if (slot.recording_id) {
            return "Already recorded today.";
        }
        return "";
    }

    openRecorder(slot) {
        // The dashboard behind the dialog is invisible, and a refresh that
        // moved a round on mid-recording would be changing something nobody can
        // see - so polling stops until the dialog closes.
        this.clock.pause();
        this.dialog.add(
            RecorderDialog,
            {
                slot,
                settings: {
                    ...(this.data.settings || {}),
                    serverOffsetMs: this.serverOffsetMs,
                },
                onRecorded: () => {},
            },
            {
                onClose: () => this.clock.resume(),
            }
        );
    }

    /**
     * Open the camera without recording anything.
     *
     * Deliberately available whether or not a round is open. Otherwise the only
     * way to find out the camera works is to wait for a window and then spend
     * the day's one real recording on it.
     */
    testCamera() {
        this.clock.pause();
        this.dialog.add(
            RecorderDialog,
            {
                testMode: true,
                settings: {
                    ...(this.data.settings || {}),
                    serverOffsetMs: this.serverOffsetMs,
                },
            },
            { onClose: () => this.clock.resume() }
        );
    }

    viewRecording(slot) {
        if (!slot.recording_id) {
            return;
        }
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "cleaning.recording",
            res_id: slot.recording_id,
            views: [[false, "form"]],
            target: "current",
        });
    }

    openSettings() {
        this.action.doAction("showroom_check.action_cleaning_config_open");
    }

    toggleDiagnostics() {
        this.ui.showDiagnostics = !this.ui.showDiagnostics;
    }

    reload() {
        this.clock.sync();
    }
}

// Registered exactly once, here. Registering the same name twice breaks the
// entire Odoo backend, not just this page.
registry.category("actions").add("cleaning_dashboard", CleaningDashboard);
