import { Component } from "@odoo/owl";

const SIZE = 78;
const STROKE = 7;

/**
 * Rounds done out of today's total, with the missed ones drawn as a red
 * segment on the same track.
 *
 * The same ring the app draws on its dashboard, to the same geometry, so the
 * two screens read as one product rather than as two takes on it.
 *
 * Sized and coloured for the gradient header, so the palette assumes a dark
 * background: white for what is done, the danger red for what was missed, and
 * a translucent white track behind both.
 *
 * Presentational only, and not registered anywhere: wired in through the
 * dashboard's `components`.
 */
export class ProgressRing extends Component {
    static template = "showroom_check.ProgressRing";
    static props = {
        done: { type: Number, optional: true },
        total: { type: Number, optional: true },
        missed: { type: Number, optional: true },
        caption: { type: String, optional: true },
    };
    static defaultProps = { done: 0, total: 0, missed: 0 };

    get size() {
        return SIZE;
    }

    get stroke() {
        return STROKE;
    }

    get centre() {
        return SIZE / 2;
    }

    get radius() {
        return (SIZE - STROKE) / 2;
    }

    get circumference() {
        return 2 * Math.PI * this.radius;
    }

    /**
     * Guard against a total of zero, and against the two segments together
     * claiming more than the ring when the data disagrees with itself.
     */
    get safeTotal() {
        return Math.max(this.props.total, 1);
    }

    get doneFraction() {
        return Math.min(this.props.done, this.safeTotal) / this.safeTotal;
    }

    get missedFraction() {
        const room = Math.max(this.safeTotal - this.props.done, 0);
        return Math.min(this.props.missed, room) / this.safeTotal;
    }

    get doneOffset() {
        return this.circumference * (1 - this.doneFraction);
    }

    get missedOffset() {
        return this.circumference * (1 - this.missedFraction);
    }

    /** -90deg, so the arc starts at the top rather than at three o'clock. */
    get doneTransform() {
        return `rotate(-90 ${this.centre} ${this.centre})`;
    }

    /** Drawn from the far end of the track, so it cannot overlap `done`. */
    get missedTransform() {
        const from = 90 - this.missedFraction * 360;
        return `rotate(${from} ${this.centre} ${this.centre})`;
    }
}
