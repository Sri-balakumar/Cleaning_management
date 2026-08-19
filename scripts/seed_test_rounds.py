"""Fill History with test rounds. DEVELOPMENT ONLY.

Deliberately outside odoo_modules/, so it can never be copied into the addons
directory along with the module and never runs anywhere real.

Run it against a development database:

    odoo shell -d <database> --addons-path=<paths> < scripts/seed_test_rounds.py

It does two things, in this order:

  1. Deletes every existing round for the company's slots.
  2. Creates ROUNDS new ones, spread across the day's slots - morning, midday,
     evening and so on - and back across recent days.

Everything goes through sudo(), which is what makes back-dating possible at
all: cleaning.recording._check_window returns immediately for a superuser, so
the window, weekday and "not close enough to now" rules are skipped. They are
there to stop somebody filing yesterday's round today, and are exactly what
seeding needs out of the way.

The one rule sudo does NOT lift is the database constraint UNIQUE (slot_id,
slot_date) - one round per slot per day - which is why this walks slots within
a day before stepping back to the day before.
"""

from datetime import timedelta

ROUNDS = 5

# The rounds a day is expected to have, created only where they are missing, so
# a database that already has its own schedule is left alone. Times are plain
# wall-clock hours in the office timezone: 9.5 means 09:30.
WANTED_SLOTS = [
    {'name': 'Morning Round', 'day_period': 'morning', 'hour_from': 9.0, 'hour_to': 10.0},
    {'name': 'Midday Round', 'day_period': 'afternoon', 'hour_from': 13.0, 'hour_to': 14.0},
    {'name': 'Evening Round', 'day_period': 'evening', 'hour_from': 17.0, 'hour_to': 18.0},
]

EVERY_DAY = {'mon': True, 'tue': True, 'wed': True, 'thu': True,
             'fri': True, 'sat': True, 'sun': True}


def seed(env):
    config = env['cleaning.config'].sudo().search([], limit=1)
    if not config:
        print('No cleaning.config found. Set the module up first.')
        return

    Slot = env['cleaning.slot'].sudo()
    Recording = env['cleaning.recording'].sudo()

    # --- the schedule ----------------------------------------------------
    #
    # Only filled in when the day has none at all. A database that already has
    # its own rounds keeps them exactly as they are: inventing a "Midday Round"
    # beside somebody's existing "Afternoon Round" would leave them with two
    # names for the same part of the day and a schedule they did not ask for.
    slots = Slot.search([('config_id', '=', config.id)],
                        order='sequence, hour_from, id')
    if not slots:
        for wanted in WANTED_SLOTS:
            Slot.create(dict(wanted, config_id=config.id, **EVERY_DAY))
            print('added slot %s' % wanted['name'])
        slots = Slot.search([('config_id', '=', config.id)],
                            order='sequence, hour_from, id')
    if not slots:
        print('No slots and none could be created.')
        return
    print('using %s existing slot(s): %s' % (len(slots), ', '.join(slots.mapped('name'))))

    # --- remove old ------------------------------------------------------
    old = Recording.search([('slot_id', 'in', slots.ids)])
    if old:
        print('deleting %s existing round(s)' % len(old))
        old.unlink()

    # --- add the test rounds ---------------------------------------------
    duration = config.duration_seconds or 60
    today = config._local_date()
    made = Recording.browse()
    day = 0

    while len(made) < ROUNDS:
        local_date = today - timedelta(days=day)
        for slot in slots:
            if len(made) >= ROUNDS:
                break
            opens, _closes = slot._window_utc(local_date)
            made |= Recording.create({
                'slot_id': slot.id,
                'slot_date': local_date,
                'user_id': env.user.id,
                'started_at': opens,
                'ended_at': opens + timedelta(seconds=duration),
                'duration_seconds': duration,
                'configured_duration_seconds': duration,
                'quality': config.video_quality,
                'file_format': config.video_format or 'mp4',
                # Honest about where these came from: they were not recorded by
                # a browser or a phone, and a column somebody reads later should
                # not claim they were.
                'capture_mode': 'manual',
            })
        day += 1
        if day > 60:
            print('Gave up after 60 days - not enough slots to make %s.' % ROUNDS)
            break

    env.cr.commit()
    print('created %s test round(s) across %s slot(s)' % (len(made), len(slots)))
    for rec in made:
        print('  %s  %s' % (rec.slot_date, rec.slot_id.name))


# `env` is provided by `odoo shell`.
seed(env)  # noqa: F821
