import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

/**
 * The evidence behind the similarity figure, one click away.
 *
 * Similar: 46% is a percentage on a scale somebody chose. The match count is
 * not: it is how many small patches of the original were found again in
 * today's photograph, each one closer to its partner than to any runner-up.
 * The same two pictures always produce the same count.
 *
 * So the count sits in a button rather than in prose - it is a thing to press
 * when a number is doubted, and the drawing behind it settles the argument by
 * showing every match as a line. That is the rule the comparison already
 * follows for its score: an answer that can be disputed has to be one that can
 * be recomputed and shown to whoever disputes it.
 *
 * The drawing is computed per request, not stored. It is looked at rarely, and
 * keeping a second picture against every photograph ever taken to save that
 * would be a poor bargain.
 */
class MatchProofDialog extends Component {
    static template = "showroom_check.MatchProofDialog";
    static components = { Dialog };
    static props = {
        shotId: Number,
        matches: Number,
        title: { type: String, optional: true },
        close: Function,
    };

    setup() {
        // Fewer lines to begin with, because a hundred of them hide what they
        // are drawn to show. Never fewer than the count claims without saying
        // so and offering the rest - the picture is the evidence for a number,
        // and evidence that quietly omits part of itself is not evidence.
        this.state = useState({ everything: false });
        this.limit = 40;
    }

    get url() {
        const all = this.state.everything ? "?all=1" : "";
        return `/showroom_check/match_proof/${this.props.shotId}${all}`;
    }

    showEverything() {
        this.state.everything = true;
    }
}

export class MatchProof extends Component {
    static template = "showroom_check.MatchProof";
    static props = { ...standardFieldProps };

    setup() {
        this.dialog = useService("dialog");
    }

    get matches() {
        return this.props.record.data[this.props.name] || 0;
    }

    open() {
        this.dialog.add(MatchProofDialog, {
            shotId: this.props.record.resId,
            matches: this.matches,
            title: this.props.record.data.name || "",
        });
    }
}

// "integer", because match_count is a plain count. The fields registry checks
// this list against the real ORM types and throws on anything else - and a
// throw here takes down every JavaScript module on the page, not just this one.
registry.category("fields").add("showroom_match_proof", {
    component: MatchProof,
    displayName: "Matching features",
    supportedTypes: ["integer"],
});
