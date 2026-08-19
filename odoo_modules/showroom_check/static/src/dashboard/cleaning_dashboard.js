import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { browser } from "@web/core/browser/browser";

import { useSlotClock } from "./use_slot_clock";
import { OpenRoundCard } from "./open_round_card";
import { ProgressRing } from "./progress_ring";
import { SlotCard } from "./slot_card";
import { RecorderDialog } from "../recorder/recorder_dialog";
import { DiagnosticsPanel } from "../diagnostics/diagnostics_panel";
import { getCapabilities } from "../recorder/media_support";

export class CleaningDashboard extends Component {
    static template = "showroom_check.CleaningDashboard";
    static components = { OpenRoundCard, ProgressRing, SlotCard, DiagnosticsPanel };
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

    /** Today's rounds, less the one the hero is already showing. */
    get slots() {
        const rows = this.data.slots || [];
        const active = this.active;
        return active ? rows.filter((row) => row.id !== active.id) : rows;
    }

    /**
     * The open round, unless it has already been recorded -- in which case
     * there is nothing left to do about it and it belongs in the list below
     * with the rest of the day.
     */
    get active() {
        const slot = this.data.active_slot;
        return slot && !slot.already_recorded ? slot : null;
    }

    get upNext() {
        return !this.active && this.data.next_slot ? this.data.next_slot : null;
    }

    /**
     * Which of the three cards the top of the page shows, or none at all.
     *
     * 'done' needs today_total: a day with no rounds at all has not been
     * finished, it was never started, and the empty state says so instead.
     */
    get heroMode() {
        if (this.active) {
            return "open";
        }
        if (this.upNext) {
            return "next";
        }
        return this.data.today_total ? "done" : null;
    }

    /**
     * undefined rather than null when there is no round: 'done' mode has none,
     * and OWL's prop validation rejects a null where an optional Object was
     * declared while letting an absent one through.
     */
    get heroRound() {
        return this.active || this.upNext || undefined;
    }

    /**
     * The hero's own gate: the server's answer AND this browser's.
     *
     * can_record alone would offer a button that cannot work on a machine with
     * no camera API, which is the one case the server cannot know about.
     */
    get heroCanRecord() {
        return Boolean(
            this.capabilities.supported && this.heroRound && this.heroRound.can_record
        );
    }

    get heroBlockedMessage() {
        if (!this.capabilities.supported) {
            return "Recording is not available in this browser.";
        }
        return this.data.deny_message || "";
    }

    /**
     * A round with the video switched off is photographs and nothing else, so
     * the button must not promise a recording.
     *
     * Tested against `false` rather than falsiness, so a server too old to send
     * the flag keeps saying "Record now" instead of quietly renaming the button
     * on every dashboard.
     */
    get capturesOnly() {
        return (this.data.settings || {}).video_enabled === false;
    }

    get greeting() {
        const hour = new Date().getHours();
        if (hour < 12) {
            return "Good morning";
        }
        if (hour < 18) {
            return "Good afternoon";
        }
        return "Good evening";
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

    /**
     * Which rounds were missed, rather than only how many.
     *
     * Manager-only, and the ACL says so: cleaning.slot.missed is readable by
     * that group alone, so the figure is only made clickable for them rather
     * than sending anybody else into an access error.
     */
    openMissed() {
        if (!this.data.is_manager) {
            return;
        }
        this.action.doAction("showroom_check.action_cleaning_slot_missed");
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
