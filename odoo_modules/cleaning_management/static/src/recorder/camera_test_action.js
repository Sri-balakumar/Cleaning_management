import { Component, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

import { RecorderDialog } from "./recorder_dialog";

/**
 * Opens the Test camera dialog on its own, so it can be reached from a button
 * on the Settings form as well as from the dashboard.
 *
 * The camera settings caused real confusion: people look for them in Settings,
 * but the choice of *which* camera is stored per computer and so cannot live on
 * a company-wide form. A button that opens this dialog bridges the two.
 *
 * The component itself renders nothing - it opens the dialog and steps aside,
 * closing itself when the dialog closes. Same shape as the help dialog in
 * hr_attendance_369.
 */
export class CameraTestAction extends Component {
    static template = xml`<div class="o_hidden"/>`;
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.dialog = useService("dialog");
        this.action = useService("action");
        this.open();
    }

    async open() {
        // The dialog needs the resolved capture settings, which only the server
        // has, so fetch them rather than duplicating the quality table here.
        const state = await this.orm.call("cleaning.config", "get_dashboard_state", []);
        const goBack = () =>
            this.action.doAction({ type: "ir.actions.act_window_close" });

        if (!state.ok) {
            goBack();
            return;
        }
        this.dialog.add(
            RecorderDialog,
            {
                testMode: true,
                settings: {
                    ...(state.settings || {}),
                    serverOffsetMs: state.server_now_ts
                        ? state.server_now_ts * 1000 - Date.now()
                        : 0,
                },
            },
            { onClose: goBack }
        );
    }
}

registry.category("actions").add("cleaning_camera_test", CameraTestAction);
