import logging

from . import models
from . import controllers

from .models.cleaning_config import DEFAULT_SLOTS

_logger = logging.getLogger(__name__)

# Headless on purpose: the server draws nothing, and the full opencv-python
# drags in GUI libraries that are not there on a headless box and fail to load
# even when they install.
OPENCV_PACKAGE = 'opencv-python-headless'
# Long enough for a sixty megabyte wheel on a slow line, short enough that a
# hung index does not leave somebody staring at an install that never finishes.
OPENCV_INSTALL_TIMEOUT = 300


def _guess_office_timezone(env, company):
    """Best guess at the timezone the office actually runs on.

    Getting this wrong is the worst failure this module has: the schedule is
    anchored to it, so a wrong guess means the Record button opens at the wrong
    time of day for everybody.

    The company partner and the installing user are both usually blank - an
    install runs as the system user, which has no timezone - so falling straight
    back to UTC lands on the one answer that is wrong for every office outside
    London. Asking the people who actually use the database is far more
    reliable: take the timezone most of them have set.
    """
    candidates = [company.partner_id.tz, env.user.tz]
    for candidate in candidates:
        if candidate:
            return candidate

    env.cr.execute("""
        SELECT p.tz, COUNT(*) AS n
          FROM res_users u
          JOIN res_partner p ON p.id = u.partner_id
         WHERE u.active AND p.tz IS NOT NULL AND p.tz != ''
         GROUP BY p.tz
         ORDER BY n DESC, p.tz
         LIMIT 1
    """)
    row = env.cr.fetchone()
    if row:
        return row[0]

    # Nothing to go on. UTC is at least honest about being a placeholder, and
    # the settings form makes the timezone the first thing you see.
    return 'UTC'


def _post_init_seed_config(env):
    """Give every existing company a configuration with three sensible rounds.

    Without this the dashboard's first impression is an empty screen with no
    hint of what to do.
    """
    # First, because it decides what the module can actually do. Never allowed
    # to stop the install: a server with no network still gets a working
    # module, it just compares less cleverly.
    _ensure_opencv()

    Config = env['cleaning.config']
    for company in env['res.company'].search([]):
        if Config.search_count([('company_id', '=', company.id)]):
            continue
        config = Config.create({
            'company_id': company.id,
            'timezone': _guess_office_timezone(env, company),
        })
        env['cleaning.slot'].create([
            dict(vals, config_id=config.id) for vals in DEFAULT_SLOTS
        ])


def _ensure_opencv():
    """Install OpenCV if it is not already here. Never fails over it.

    Photographs are compared without it, but only on overall brightness: it
    cannot tell whether two pictures are even of the same thing, and a round
    cannot be read out of its recording at all. Everything the last two
    versions added needs it, so leaving it as a line in the README that
    somebody has to find and run by hand meant most installs quietly did half
    of what they say they do.

    Deliberately NOT an `external_dependencies` entry in the manifest. That
    does the opposite of this: it REFUSES to install the module anywhere
    OpenCV is absent, which would lock out every server that cannot pip
    install - the very ones this is trying to help.

    Returns True where OpenCV can be used afterwards.

    Three ways this legitimately fails, all of them ending in a warning and a
    working module rather than an error:

      * no network, or no pip in this interpreter;
      * no write access to site-packages, which is normal for a service
        running out of Program Files - so a --user install is tried second,
        into a directory the service account does own;
      * a wheel that will not build for this platform.
    """
    from .models import cleaning_image_compare as compare
    if compare.cv2 is not None:
        return True

    import importlib
    import subprocess
    import sys

    _logger.info(
        "Showroom Check: OpenCV is not installed. Installing "
        "%s so recordings can be read and photographs compared across "
        "cameras.", OPENCV_PACKAGE)

    base = [sys.executable, '-m', 'pip', 'install',
            '--disable-pip-version-check', '--no-input']
    # Plain first. Only where that is refused for want of permission is
    # --user right: it installs into the account the service runs as, which
    # is a different place on disk and worth being deliberate about rather
    # than reaching for first.
    for arguments in (base + [OPENCV_PACKAGE],
                      base + ['--user', OPENCV_PACKAGE]):
        try:
            result = subprocess.run(
                arguments, capture_output=True, text=True,
                timeout=OPENCV_INSTALL_TIMEOUT, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            _logger.warning(
                "Showroom Check: could not run pip to install OpenCV - %s", exc)
            break
        if result.returncode == 0:
            break
        _logger.info(
            "Showroom Check: %s exited %s. %s",
            ' '.join(arguments[-2:]), result.returncode,
            (result.stderr or '').strip()[:500])

    # Ask the interpreter again rather than trusting pip's exit code: a wheel
    # can install and still not import, and what matters here is whether the
    # comparison can actually use it.
    importlib.invalidate_caches()
    try:
        import cv2
        import numpy
    except ImportError:
        _logger.warning(
            "Showroom Check: OpenCV could not be installed automatically.\n"
            "The module works without it, but recordings cannot be read and "
            "photographs are compared on brightness alone.\n"
            "To install it by hand, run this as the account the server runs "
            "as, then restart the service:\n"
            "    %s -m pip install %s",
            sys.executable, OPENCV_PACKAGE)
        return False

    # Hand it to the comparison engine, which bound both names to None when it
    # was first imported - minutes ago, before the install. Without this the
    # running process carries on believing OpenCV is absent until it is
    # restarted, which is a confusing thing to happen right after a successful
    # install.
    #
    # Only THIS worker, though. Odoo runs several, and the others still hold
    # the None they imported. A restart is what makes it true everywhere,
    # which is why the message below says so.
    compare.cv2 = cv2
    compare.numpy = numpy
    _logger.info(
        "Showroom Check: OpenCV %s is installed and in use. Restart the "
        "server when convenient so every worker picks it up.", cv2.__version__)
    return True
