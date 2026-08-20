/** @odoo-module **/

import { registry } from "@web/core/registry";
import { Component, useState, onWillStart, xml } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";

/**
 * One shelf of guides, as cards.
 *
 * Which shelf is decided by the action's params, so both menu entries share
 * this one component rather than duplicating it per section.
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
        this.state = useState({ docs: [], loaded: false });

        onWillStart(async () => {
            const section = this.props.section || "app";
            this.state.docs = await this.orm.searchRead(
                "cleaning.manual",
                [["section", "=", section], ["active", "=", true]],
                ["name", "description", "icon"],
                { order: "sequence, id" }
            );
            this.state.loaded = true;
        });
    }

    openGuide(id) {
        window.open("/showroom_check/help/guide/" + id, "_blank");
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
