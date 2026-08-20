import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

/**
 * One photograph on a comparison card, big enough to actually look at.
 *
 * The two pictures on a card are thumbnails - they have to be, or the pair
 * stops fitting side by side and stops being comparable at a glance. But a
 * thumbnail is no use for deciding whether a shelf was restocked, and clicking
 * one used to open the shot's record instead: the click fell through to the
 * kanban card, which answers a question nobody asked.
 *
 * Not the image widget's own `zoom` option: that is a hover tooltip, and it
 * disappears the moment the pointer moves. This is a click, and it stays until
 * it is dismissed.
 *
 * The picture is shown through the dialog service rather than an overlay of
 * our own, so it is rendered at the root of the page. Inside the card it would
 * be clipped by the kanban's own overflow and stacking.
 */
class PhotoDialog extends Component {
    static template = "showroom_check.PhotoDialog";
    static components = { Dialog };
    static props = {
        url: String,
        title: { type: String, optional: true },
        close: Function,
    };
}

export class ShowroomPhoto extends Component {
    static template = "showroom_check.ShowroomPhoto";
    static props = { ...standardFieldProps };

    setup() {
        this.dialog = useService("dialog");
    }

    get url() {
        const record = this.props.record;
        return `/web/image/${record.resModel}/${record.resId}/${this.props.name}`;
    }

    get label() {
        // The view's own name where the record carries one - "Front view" reads
        // better over a full-size picture than the field's label does.
        return this.props.record.data.name || "";
    }

    open() {
        this.dialog.add(PhotoDialog, { url: this.url, title: this.label });
    }
}

// Only "binary". An Image field is a binary column with a size policy on
// top - "image" is not an ORM field type, and the fields registry validates
// this list against the real ones and throws on anything else. Getting it
// wrong takes down every JavaScript module on the page, not just this widget.
registry.category("fields").add("showroom_photo", {
    component: ShowroomPhoto,
    displayName: "Showroom photograph",
    supportedTypes: ["binary"],
});
