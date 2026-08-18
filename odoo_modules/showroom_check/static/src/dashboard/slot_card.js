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

    get statusLabel() {
        if (this.props.pending) {
            return "Opening...";
        }
        return (
            {
                done: "Recorded",
                open: "Open now",
                upcoming: "Later today",
                missed: "Not recorded",
            }[this.props.round.state] || ""
        );
    }
}
