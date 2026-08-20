"""Install OpenCV on a server that has been running without it.

The post_init_hook only fires on a fresh install, so without this every
database that already has the module upgrades into a version whose headline
feature - reading a round out of its recording - cannot run, and says so on a
warning banner rather than simply working.

Same helper the install uses, and the same rule: it may not fail the upgrade.
A server with no network, or no write access to its own site-packages, comes
out of this exactly as it went in, with a line in the log saying what to run
by hand.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    from odoo.addons.showroom_check import _ensure_opencv

    if _ensure_opencv():
        _logger.info(
            "Showroom Check: OpenCV is available, so recordings can be read "
            "and photographs compared across cameras.")
    else:
        _logger.warning(
            "Showroom Check: upgraded without OpenCV. Rounds recorded as a "
            "video cannot be checked until it is installed - see the warning "
            "on Configuration > Settings > Video.")
