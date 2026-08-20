"""Give every existing original its ORB descriptors.

The descriptors are computed when an original is saved, so everything stored
before this version has none. Without them a round falls back to comparing
tiles alone and never gets told whether it photographed the same view at all -
silently, which is the worst way for a feature to be missing.

Re-saving each original through write() would recompute them, but it would also
re-run the resize and rewrite the attachment for no reason. This asks the
comparison module directly and writes the one new column.

Cheap: one decode per original, and there are at most four per configuration.
Nothing here touches recordings - existing rounds keep the scores they were
given, and `Compare again` on a recording will re-run them against the new
descriptors for anybody who wants it.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    from odoo import api, SUPERUSER_ID
    from odoo.addons.showroom_check.models import cleaning_image_compare as compare

    if compare.cv2 is None:
        _logger.info(
            "Showroom Check: OpenCV is not installed, so originals keep tile "
            "comparison only. Install opencv-python-headless and re-save an "
            "original to enable matching across cameras.")
        return

    env = api.Environment(cr, SUPERUSER_ID, {})
    originals = env['cleaning.reference.image'].search([])
    done = 0
    for original in originals:
        raw = original._raw_image()
        if not raw:
            continue
        features = compare.encode_features(compare.orb_features(raw))
        if features:
            original.write({'features': features})
            done += 1

    _logger.info(
        "Showroom Check: prepared feature descriptors for %s of %s originals.",
        done, len(originals))
