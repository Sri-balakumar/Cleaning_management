import { Component } from "@odoo/owl";
import { formatCountdown } from "../recorder/media_support";

/**
 * The single card at the top of the dashboard that says what to do now.
 *
 * `mode` is explicit rather than worked out from the round, because the two
 * payloads it is built from are NOT the same shape:
 *
 *   'open' -> `active_slot`, assembled by get_dashboard_state with
 *             seconds_remaining / can_record / will_overrun
 *   'next' -> `next_slot`, a plain row from _slot_rows with seconds_until_open
 *   'done' -> no round at all, just today's totals
 *
 * Treating them as interchangeable is how a countdown ends up reading
 * `undefined`, so each mode reads only the fields its own payload carries.
 *
 * The same card the app puts at the top of its dashboard. Presentational only,
 * and not registered anywhere: wired in through the dashboard's `components`.
 */
export class OpenRoundCard extends Component {
    static template = "showroom_check.OpenRoundCard";
    static props = {
        mode: String,
        round: { type: Object, optional: true },
        countdown: { type: Object, optional: true },
        capturesOnly: { type: Boolean, optional: true },
        canRecord: { type: Boolean, optional: true },
        blockedMessage: { type: String, optional: true },
        onRecord: { type: Function, optional: true },
        done: { type: Number, optional: true },
        total: { type: Number, optional: true },
    };

    get isOpen() {
        return this.props.mode === "open";
    }

    /** Live value where the clock has one, the payload's own figure until then. */
    get seconds() {
        const countdown = this.props.countdown;
        if (this.isOpen) {
            return countdown ? countdown.untilClose : this.props.round.seconds_remaining;
        }
        return countdown ? countdown.untilOpen : this.props.round.seconds_until_open;
    }

    get countdownLabel() {
        return formatCountdown(this.seconds);
    }

    get cardClass() {
        // The soft gradient for a round that has not opened: it is a statement
        // of what is coming, not a call to go and do something.
        return this.isOpen ? "cm-hero" : "cm-hero cm-hero-soft";
    }

    get actionLabel() {
        return this.props.capturesOnly ? "Capture now" : "Record now";
    }

    get actionIcon() {
        return this.props.capturesOnly ? "fa fa-camera me-2" : "fa fa-video-camera me-2";
    }
}
