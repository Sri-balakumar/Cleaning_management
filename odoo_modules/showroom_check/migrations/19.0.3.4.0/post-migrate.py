"""Fill in the similarity figure for rounds already recorded.

Similarity is derived from the descriptor match count, which every scored
photograph already has - so this is a re-run of the comparison rather than
anything new being computed. The band a round shows also changed (a score
that could not be lined up now reads 'Could not line up' rather than
'Not compared'), and that is read live off the stored fields, so the re-run
is what makes existing rounds tell the truth.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    from odoo import api, SUPERUSER_ID

    env = api.Environment(cr, SUPERUSER_ID, {})
    shots = env['cleaning.recording.shot'].search([])
    shots._run_match_comparison()
    _logger.info(
        "Showroom Check: re-scored %s photographs so they carry a similarity "
        "figure.", len(shots))
