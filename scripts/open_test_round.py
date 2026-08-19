"""Make a round capturable right now. DEVELOPMENT ONLY.

    odoo shell -d <database> -c odoo.conf --no-http < scripts/open_test_round.py

Two things stop a round being captured from the app, and this clears both:

  1. A round already recorded today. One per slot per day is a database
     constraint, so the slot shows "Recorded" and offers nothing.
  2. The clock being outside every window. The app refuses to start a round
     whose state is not 'open', so a schedule whose windows have all closed
     leaves nothing to do until tomorrow.

The second is fixed by retiming a slot rather than by widening all of them:
two windows may never be open at once (cleaning.slot._check_no_overlap), since
the dashboard would not know which round was being recorded. So this drops one
slot into a gap in the existing schedule and leaves every other window alone.

The overlap test is strict - `hour_from < other.hour_to AND hour_to >
other.hour_from` - so windows that merely touch at an endpoint are allowed,
which is what makes a gap usable down to the minute.
"""

from datetime import timedelta

# Which slot to sacrifice as the test window. Named rather than positional so
# this cannot quietly retime somebody's real Morning Round.
TEST_SLOT_NAME = 'Test evng'

# How long the test window should stay open, in hours.
WINDOW_HOURS = 1.5


def open_a_round(env):
    config = env['cleaning.config'].sudo().search([], limit=1)
    if not config:
        print('No cleaning.config found.')
        return

    Slot = env['cleaning.slot'].sudo()
    Recording = env['cleaning.recording'].sudo()

    tz = config._tz()
    now_local = env.cr.now().replace(tzinfo=None)
    # The office wall clock, which is what a window is expressed in.
    import pytz
    office_now = pytz.utc.localize(now_local).astimezone(tz)
    now_hours = office_now.hour + office_now.minute / 60.0
    today = config._local_date()

    slots = Slot.search([('config_id', '=', config.id)])
    slot = slots.filtered(lambda s: s.name == TEST_SLOT_NAME)[:1]
    if not slot:
        print('No slot named %r - nothing retimed.' % TEST_SLOT_NAME)
        return

    # --- 1. free today ----------------------------------------------------
    todays = Recording.search([
        ('slot_id', 'in', slots.ids),
        ('slot_date', '=', today),
    ])
    if todays:
        print('deleting %s round(s) already recorded today' % len(todays))
        todays.unlink()

    # --- 2. find a gap around now ----------------------------------------
    #
    # Every other active window, so the test one can be dropped between two of
    # them without tripping the overlap rule.
    others = (slots - slot).filtered('active').sorted(lambda s: s.hour_from)
    lower, upper = 0.0, 24.0
    for other in others:
        if other.hour_to <= now_hours:
            lower = max(lower, other.hour_to)
        if other.hour_from >= now_hours:
            upper = min(upper, other.hour_from)

    if not (lower <= now_hours < upper):
        print('%s is inside another round\'s window - it is already open.'
              % office_now.strftime('%H:%M'))
        return

    start = max(lower, now_hours - 0.25)      # a little behind now
    end = min(upper, start + WINDOW_HOURS)
    if end <= start:
        print('No gap around %s wide enough for a window.'
              % office_now.strftime('%H:%M'))
        return

    slot.write({
        'hour_from': start,
        'hour_to': end,
        'active': True,
        'mon': True, 'tue': True, 'wed': True, 'thu': True,
        'fri': True, 'sat': True, 'sun': True,
    })

    env.cr.commit()

    def hhmm(value):
        hours = int(value)
        return '%02d:%02d' % (hours, round((value - hours) * 60))

    print('office time now: %s' % office_now.strftime('%H:%M'))
    print('%r is now open %s - %s and has no round today.'
          % (slot.name, hhmm(start), hhmm(end)))
    print('Other windows left untouched:')
    for other in others:
        print('  %-18s %s - %s' % (other.name, hhmm(other.hour_from), hhmm(other.hour_to)))


open_a_round(env)  # noqa: F821
