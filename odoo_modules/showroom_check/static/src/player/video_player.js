import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";

/**
 * Plays a stored recording inside the form.
 *
 * Odoo's plain binary field renders as a download link, which is not much use
 * for video - somebody reviewing a cleaning round wants to watch it, not save
 * it. This puts a real player on the form and streams from the module's own
 * route, which enforces the same record rules as everything else.
 *
 * `preload="metadata"` rather than `auto`: the recordings list can be long, and
 * fetching every clip in full just because a form was opened would be wasteful.
 * Metadata is enough to show the duration and a scrub bar.
 */
export class CleaningVideoPlayer extends Component {
    static template = "showroom_check.VideoPlayer";
    static props = { ...standardWidgetProps };

    get recordId() {
        return this.props.record.resId;
    }

    /** Streamed through the module's route so access follows the record rules. */
    get videoUrl() {
        return `/showroom_check/video/${this.recordId}`;
    }

    /**
     * A recording whose video has been removed by the retention setting still
     * has its log entry, and rendering a broken player for it would look like a
     * fault rather than the deliberate behaviour it is.
     */
    get hasVideo() {
        const data = this.props.record.data || {};
        return Boolean(this.recordId) && Boolean(data.file_size);
    }

    get sizeLabel() {
        const mb = (this.props.record.data || {}).file_size_mb || 0;
        return `${mb.toFixed(1)} MB`;
    }
}

registry.category("view_widgets").add("cleaning_video_player", {
    component: CleaningVideoPlayer,
    // Named so the form only re-renders the player when something it shows
    // actually changes.
    fieldDependencies: [
        { name: "file_size", type: "integer" },
        { name: "file_size_mb", type: "float" },
    ],
});
