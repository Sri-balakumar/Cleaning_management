"""Re-score every photograph under the tightened ratio test.

ORB_RATIO went from 0.75 to 0.65 because the looser setting was pairing one
key with a different key - drawing the matches made it plain. match_count and
similarity are both stored and both derive from that filter, so without this
the cards keep numbers counted the old way. They go DOWN, and that is the
point: the old ones were inflated by matches that were never real.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    from odoo import api, SUPERUSER_ID

    env = api.Environment(cr, SUPERUSER_ID, {})
    shots = env['cleaning.recording.shot'].search([])
    shots._run_match_comparison()
    _logger.info(
        "Showroom Check: re-scored %s photographs against the tightened "
        "match filter.", len(shots))
