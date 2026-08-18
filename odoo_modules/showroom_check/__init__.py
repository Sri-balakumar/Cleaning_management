from . import models
from . import controllers

from .models.cleaning_config import DEFAULT_SLOTS


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
