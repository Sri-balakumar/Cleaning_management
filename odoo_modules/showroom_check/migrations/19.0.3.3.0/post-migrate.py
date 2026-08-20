"""Give every original its letterboxed tile grid, and re-score what exists.

Feature matching now works on a letterboxed square rather than a stretched
one, because stretching 4:3 into 1:1 was destroying the very descriptors it
depends on - one view went from 41 descriptor matches to 106 on that change
alone. A registered comparison therefore lands in the padded square, and the
original has to be described there to be measured against.

Two steps, and the second is not optional: a round scored under the old
registration keeps a figure that the new one would not have produced, and
match_level reads live off it.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    from odoo import api, SUPERUSER_ID
    from odoo.addons.showroom_check.models import cleaning_image_compare as compare

    env = api.Environment(cr, SUPERUSER_ID, {})

    originals = env['cleaning.reference.image'].search([])
    prepared = 0
    for original in originals:
        raw = original._raw_image()
        if not raw:
            continue
        # The descriptors must be recomputed too, not just the padded
        # grid. Detection moved from the stretched square to the letterboxed
        # one, and descriptors taken in one space do not match a photograph
        # measured in the other - they come back at a third of the count and
        # every round reads as a different view.
        try:
            padded = compare.encode_signature(compare.padded_tile_signature(raw))
        except compare.CompareError:
            continue
        values = {}
        if padded:
            values['signature_padded'] = padded
        features = compare.encode_features(compare.orb_features(raw))
        if features:
            values['features'] = features
        if values:
            original.write(values)
            prepared += 1

    # Re-run every comparison. One decode per photograph, so it is minutes on a
    # large installation and worth saying so in the log rather than appearing
    # to hang.
    shots = env['cleaning.recording.shot'].search([])
    _logger.info(
        "Showroom Check: prepared %s of %s originals for registration, "
        "now re-scoring %s photographs.", prepared, len(originals), len(shots))
    shots._run_match_comparison()

    registered = len(shots.filtered('registered'))
    _logger.info(
        "Showroom Check: re-scored %s photographs, %s of which lined up "
        "against their original.", len(shots), registered)
