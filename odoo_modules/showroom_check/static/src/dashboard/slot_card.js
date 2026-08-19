import { Component } from "@odoo/owl";
import { formatCountdown } from "../recorder/media_support";

/**
 * One cleaning round on the dashboard.
 *
 * Presentational only - it is given everything it shows and hands clicks back
 * up. It never decides for itself whether recording is allowed; that answer
 * always comes from the server.
 *
 * The main prop is called `round` rather than `slot`, because `slot` is
 * meaningful to the template engine and is best left alone.
 *
 * Not registered anywhere: it is wired in through the dashboard's `components`.
 */
export class SlotCard extends Component {
    static template = "showroom_check.SlotCard";
    static props = {
        round: Object,
        countdown: { type: Object, optional: true },
        pending: { type: Boolean, optional: true },
        canRecord: { type: Boolean, optional: true },
        capturesOnly: { type: Boolean, optional: true },
        blockedMessage: { type: String, optional: true },
        onRecord: Function,
        onView: { type: Function, optional: true },
    };

    get untilOpen() {
        return this.props.countdown
            ? this.props.countdown.untilOpen
            : this.props.round.seconds_until_open;
    }

    get untilClose() {
        return this.props.countdown
            ? this.props.countdown.untilClose
            : this.props.round.seconds_until_close;
    }

    get openCountdown() {
        return formatCountdown(this.untilOpen);
    }

    get closeCountdown() {
        return formatCountdown(this.untilClose);
    }

    /** Card colour by state, so the whole day reads at a glance. */
    get cardClass() {
        if (this.props.pending) {
            return "cm-slot-card cm-slot-pending";
        }
        return (
            {
                done: "cm-slot-card cm-slot-done",
                open: "cm-slot-card cm-slot-open",
                upcoming: "cm-slot-card cm-slot-upcoming",
                missed: "cm-slot-card cm-slot-missed",
            }[this.props.round.state] || "cm-slot-card"
        );
    }

    /** The app's four words, so a round reads the same in both interfaces. */
    get statusLabel() {
        if (this.props.pending) {
            return "Opening...";
        }
        return (
            {
                done: "Recorded",
                open: "Open now",
                upcoming: "Upcoming",
                missed: "Missed",
            }[this.props.round.state] || ""
        );
    }

    get badgeClass() {
        if (this.props.pending) {
            return "cm-slot-status cm-status-upcoming";
        }
        return (
            {
                done: "cm-slot-status cm-status-done",
                open: "cm-slot-status cm-status-open",
                upcoming: "cm-slot-status cm-status-upcoming",
                missed: "cm-slot-status cm-status-missed",
            }[this.props.round.state] || "cm-slot-status cm-status-upcoming"
        );
    }

    /**
     * With the video switched off a round is photographs and nothing else, so
     * neither button may promise a recording. The flag itself is read strictly
     * against `false` by the dashboard, one level up.
     */
    get actionLabel() {
        return this.props.capturesOnly ? "Capture now" : "Record now";
    }

    get upcomingLabel() {
        return this.props.capturesOnly ? "Capture" : "Record";
    }

    get actionIcon() {
        return this.props.capturesOnly ? "fa fa-camera me-2" : "fa fa-video-camera me-2";
    }
}
