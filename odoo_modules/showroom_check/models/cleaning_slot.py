from datetime import datetime

import pytz

from odoo import api, fields, models
from odoo.exceptions import ValidationError

from .cleaning_config import float_to_time, format_float_time

WEEKDAY_FIELDS = ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
WEEKDAY_LABELS = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')


class CleaningSlot(models.Model):
    _name = 'cleaning.slot'
    _description = 'Cleaning Time Slot'
    _order = 'sequence, hour_from, id'

    config_id = fields.Many2one(
        'cleaning.config', string='Configuration', required=True,
        index=True, ondelete='cascade')
    company_id = fields.Many2one(
        related='config_id.company_id', store=True, index=True, readonly=True)

    name = fields.Char(
        string='Name', required=True,
        help="Shown on the dashboard, for example 'Morning Round'.")
    sequence = fields.Integer(string='Sequence', default=10)
    active = fields.Boolean(string='Active', default=True)
    day_period = fields.Selection(
        [('morning', 'Morning'), ('afternoon', 'Afternoon'),
         ('evening', 'Evening'), ('night', 'Night')],
        string='Period', required=True, default='morning')

    # Plain wall-clock times in the office timezone, entered with the
    # float_time widget so 09:30 is typed as "09:30" and stored as 9.5.
    hour_from = fields.Float(
        string='From', required=True, default=9.0, index=True,
        help="Start of the window, in the office timezone set on the "
             "configuration.\n\n"
             "A window cannot run past midnight. For a night round from 22:00 "
             "to 02:00, create two slots: 22:00-23:59 and 00:00-02:00.")
    hour_to = fields.Float(
        string='To', required=True, default=10.0,
        help="End of the window, in the office timezone. Must be later than "
             "the start time on the same day.")
    duration_minutes = fields.Float(
        string='Window Length (minutes)', compute='_compute_duration_minutes',
        store=True)

    mon = fields.Boolean(string='Mon', default=True)
    tue = fields.Boolean(string='Tue', default=True)
    wed = fields.Boolean(string='Wed', default=True)
    thu = fields.Boolean(string='Thu', default=True)
    fri = fields.Boolean(string='Fri', default=True)
    sat = fields.Boolean(string='Sat', default=True)
    sun = fields.Boolean(string='Sun', default=False)
    days_display = fields.Char(string='Days', compute='_compute_days_display')

    note = fields.Text(
        string='Instructions',
        help="Shown on the dashboard while this round's window is open, for "
             "example 'Include the pantry and both washrooms.'")

    _check_hours = models.Constraint(
        'CHECK (hour_from >= 0 AND hour_to <= 24 AND hour_to > hour_from)',
        'A time slot must start at or after 00:00, end at or before 24:00, '
        'and end after it starts. A window that runs past midnight must be '
        'entered as two separate slots.',
    )

    # ------------------------------------------------------------------
    # Computes
    # ------------------------------------------------------------------
    @api.depends('hour_from', 'hour_to')
    def _compute_duration_minutes(self):
        for slot in self:
            slot.duration_minutes = max(0.0, (slot.hour_to - slot.hour_from) * 60.0)

    @api.depends(*WEEKDAY_FIELDS)
    def _compute_days_display(self):
        for slot in self:
            days = [
                label for field, label in zip(WEEKDAY_FIELDS, WEEKDAY_LABELS)
                if slot[field]
            ]
            if len(days) == 7:
                slot.days_display = 'Every day'
            elif not days:
                slot.days_display = 'Never'
            else:
                slot.days_display = ', '.join(days)

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------
    @api.onchange('hour_from', 'hour_to')
    def _onchange_hours(self):
        # Same clamp resource.calendar.attendance uses, so the values are
        # already sane before the database constraint ever sees them.
        self.hour_from = min(self.hour_from, 23.99)
        self.hour_from = max(self.hour_from, 0.0)
        self.hour_to = min(self.hour_to, 24)
        self.hour_to = max(self.hour_to, 0.0)
        # avoid wrong order
        self.hour_to = max(self.hour_to, self.hour_from)

    @api.constrains('config_id', 'hour_from', 'hour_to', 'active', *WEEKDAY_FIELDS)
    def _check_no_overlap(self):
        """Two windows open at once would make "which round is this?" ambiguous.

        Cheaper and clearer to forbid it than to invent a tie-break rule that
        nobody will remember.
        """
        for slot in self.filtered('active'):
            candidates = self.search([
                ('config_id', '=', slot.config_id.id),
                ('id', '!=', slot.id),
                ('active', '=', True),
                ('hour_from', '<', slot.hour_to),
                ('hour_to', '>', slot.hour_from),
            ])
            clashing = candidates.filtered(
                lambda other: other._weekday_mask() & slot._weekday_mask())
            if clashing:
                other = clashing[0]
                raise ValidationError(self.env._(
                    "\"%(this)s\" (%(this_from)s-%(this_to)s) overlaps "
                    "\"%(other)s\" (%(other_from)s-%(other_to)s) on at least "
                    "one day of the week.\n\n"
                    "Two rounds cannot be open at the same time, because the "
                    "dashboard would not know which one is being recorded.",
                    this=slot.name,
                    this_from=format_float_time(slot.hour_from),
                    this_to=format_float_time(slot.hour_to),
                    other=other.name,
                    other_from=format_float_time(other.hour_from),
                    other_to=format_float_time(other.hour_to),
                ))

    @api.constrains(*WEEKDAY_FIELDS)
    def _check_any_weekday(self):
        for slot in self.filtered('active'):
            if not slot._weekday_mask():
                raise ValidationError(self.env._(
                    "\"%(name)s\" does not run on any day of the week, so it "
                    "would never open. Tick at least one day, or untick "
                    "Active.",
                    name=slot.name,
                ))

    # ------------------------------------------------------------------
    # Schedule helpers
    # ------------------------------------------------------------------
    def _weekday_mask(self):
        """Set of weekday numbers this slot runs on. 0 = Monday, per date.weekday()."""
        self.ensure_one()
        return {
            index for index, field in enumerate(WEEKDAY_FIELDS) if self[field]
        }

    def _runs_on(self, weekday):
        return weekday in self._weekday_mask()

    def _window_utc(self, local_date):
        """This slot's window on ``local_date``, as naive UTC datetimes.

        ``local_date`` is a date in the *office* timezone. The two values that
        come back are naive UTC, so they can be compared directly against
        ``fields.Datetime.now()`` and stored in a Datetime column.
        """
        self.ensure_one()
        tz = self.config_id._tz()

        def to_utc(naive_local):
            try:
                # is_dst=None makes pytz raise rather than guess for a local
                # time that either does not exist (clocks jumped forward) or
                # happens twice (clocks went back). India has no daylight
                # saving, so this only matters if the office timezone is ever
                # changed to one that does.
                aware = tz.localize(naive_local, is_dst=None)
            except (pytz.exceptions.AmbiguousTimeError,
                    pytz.exceptions.NonExistentTimeError):
                aware = tz.localize(naive_local, is_dst=False)
            return aware.astimezone(pytz.utc).replace(tzinfo=None)

        opens = to_utc(datetime.combine(local_date, float_to_time(self.hour_from)))
        closes = to_utc(datetime.combine(local_date, float_to_time(self.hour_to)))
        return opens, closes

    def _window_label(self):
        self.ensure_one()
        return '%s - %s' % (
            format_float_time(self.hour_from), format_float_time(self.hour_to))
