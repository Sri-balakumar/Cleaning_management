from odoo import fields, models
from odoo.tools import SQL


class CleaningSlotMissed(models.Model):
    """Rounds whose window has passed with no recording.

    A database view rather than a table: nothing to store, nothing to keep in
    step, and no cleanup of its own. It reports on completed days only - today
    is still in progress and belongs on the dashboard, not in a report of
    failures.
    """
    _name = 'cleaning.slot.missed'
    _description = 'Missed Cleaning Rounds'
    _auto = False
    _order = 'slot_date desc, hour_from'
    _rec_name = 'slot_id'

    slot_date = fields.Date(string='Date', readonly=True)
    slot_id = fields.Many2one('cleaning.slot', string='Round', readonly=True)
    config_id = fields.Many2one(
        'cleaning.config', string='Configuration', readonly=True)
    company_id = fields.Many2one('res.company', string='Company', readonly=True)
    hour_from = fields.Float(string='From', readonly=True)
    hour_to = fields.Float(string='To', readonly=True)
    day_period = fields.Selection(
        [('morning', 'Morning'), ('afternoon', 'Afternoon'),
         ('evening', 'Evening'), ('night', 'Night')],
        string='Period', readonly=True)

    @property
    def _table_query(self):
        return SQL("""
            SELECT
                -- A stable identifier built from the slot and the date. Row
                -- numbers would do here too, except they change from one query
                -- to the next, so a record opened from the list would be a
                -- different record by the time it was read again.
                -- Cast back to int, because that is what an id column is. The
                -- multiplier leaves room for a century of dates per round.
                (s.id::bigint * 100000
                 + (d.day::date - DATE '2000-01-01'))::int AS id,
                d.day::date  AS slot_date,
                s.id         AS slot_id,
                s.config_id  AS config_id,
                s.company_id AS company_id,
                s.hour_from  AS hour_from,
                s.hour_to    AS hour_to,
                s.day_period AS day_period
            FROM cleaning_slot s
            JOIN cleaning_config c ON c.id = s.config_id
            CROSS JOIN LATERAL generate_series(
                -- Bounded on both ends. Without the floor, a slot created two
                -- years ago would generate seven hundred rows every time the
                -- report is opened.
                GREATEST(
                    s.create_date::date,
                    (now() AT TIME ZONE c.timezone)::date - INTERVAL '90 days'
                ),
                -- Yesterday, in the OFFICE timezone.
                --
                -- `now() AT TIME ZONE <zone>` converts the current instant INTO
                -- that zone. Writing `(now() AT TIME ZONE 'UTC') AT TIME ZONE
                -- <zone>` instead reads the UTC wall clock and then re-labels it
                -- as local, which shifts the wrong way: at 20:00 UTC (01:30 in
                -- India, already the next day) it yields the previous date, so
                -- a whole day of rounds silently drops out of this report for
                -- the small hours of every morning. It also quietly depends on
                -- the database session's own timezone.
                --
                -- CURRENT_DATE is wrong here for the same underlying reason: it
                -- is the server's date, not the office's.
                (now() AT TIME ZONE c.timezone)::date - INTERVAL '1 day',
                INTERVAL '1 day'
            ) AS d(day)
            WHERE s.active
              AND CASE EXTRACT(ISODOW FROM d.day)
                    WHEN 1 THEN s.mon
                    WHEN 2 THEN s.tue
                    WHEN 3 THEN s.wed
                    WHEN 4 THEN s.thu
                    WHEN 5 THEN s.fri
                    WHEN 6 THEN s.sat
                    ELSE s.sun
                  END
              AND NOT EXISTS (
                    SELECT 1
                      FROM cleaning_recording r
                     WHERE r.slot_id = s.id
                       AND r.slot_date = d.day::date
              )
        """)
