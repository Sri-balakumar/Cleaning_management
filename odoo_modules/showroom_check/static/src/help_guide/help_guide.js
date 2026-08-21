/** @odoo-module **/

import { registry } from "@web/core/registry";
import { Component, useState, onWillStart, xml } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";

/**
 * One shelf of guides, as cards.
 *
 * Only Help > User Manual reaches this now: the app's manuals open their PDF
 * directly, and a card that is a title and a download button is a worse list
 * than the list. The shelf is still a param rather than a constant, so pointing
 * a menu back at the other one is a single record.
 *
 * "Open guide" leaves for a plain page rather than rendering here on purpose:
 * a guide is read at length, sometimes printed, and a dialog is the wrong
 * shape for either.
 */
export class HelpGuideDialog extends Component {
    static components = { Dialog };
    static template = "showroom_check.HelpGuideDialog";
    static props = {
        section: { type: String, optional: true },
        title: { type: String, optional: true },
        close: { type: Function, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        // Resolved once, and read everywhere else from here. Defaulting in one
        // place and comparing props.section in another is how the list ends up
        // querying one shelf while the buttons behave like the other.
        this.section = this.props.section || "app";
        this.state = useState({ docs: [], loaded: false });

        onWillStart(async () => {
            // `audience` so a mixed shelf can say which card is which. The
            // phone already captions those rows; without this the backend is
            // the only place a manager cannot tell the two apart.
            this.state.docs = await this.orm.searchRead(
                "cleaning.manual",
                [["section", "=", this.section], ["active", "=", true]],
                ["name", "description", "icon", "audience", "pdf_url"],
                { order: "sequence, id" }
            );
            this.state.loaded = true;
        });
    }

    /** Does this card open the document itself rather than a page about it? */
    opensPdf(doc) {
        return this.section === "app" && !!doc.pdf_url;
    }

    /**
     * Open a document.
     *
     * An app manual goes straight to the PDF: somebody opening one wants the
     * manual, and a page about it first is a step in front of the thing they
     * came for. The module's manual keeps its guide page, which is written to
     * be read rather than to introduce a download.
     *
     * Either way a document with no PDF falls through to the guide page - a
     * guide is often written long before anyone gets round to the document, and
     * a button that does nothing is worse than one that shows what there is.
     */
    openDoc(doc) {
        window.open(
            this.opensPdf(doc) ? doc.pdf_url : "/showroom_check/help/guide/" + doc.id,
            "_blank"
        );
    }
}

/**
 * The menu entry. Opens the dialog, then steps back where it came from, so
 * closing it does not leave an empty screen behind.
 */
export class HelpGuideClientAction extends Component {
    static template = xml`<div class="o_hidden"/>`;
    static props = ["*"];

    setup() {
        const dialog = useService("dialog");
        const action = useService("action");
        const params = this.props.action?.params || {};
        dialog.add(
            HelpGuideDialog,
            { section: params.section, title: params.title },
            { onClose: () => action.doAction({ type: "ir.actions.act_window_close" }) }
        );
    }
}

registry.category("actions").add("showroom_check_help_guide", HelpGuideClientAction);
