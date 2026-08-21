"""Stop upgrades overwriting a manual somebody uploaded.

The two shipped guides are now wrapped in `<data noupdate="1">`, so a fresh
install seeds them and then leaves them alone. That flag only reaches the
database on INSERT: Odoo's xmlid upsert is

    ON CONFLICT (module, name)
    DO UPDATE SET (model, res_id, write_date) = (...)

and `noupdate` is not in that SET list (see ir_model_data._build_update_xmlids_query).
So every database that already has these records keeps noupdate = false however
the data file is written, and carries on republishing the shipped guide over
whatever the administrator uploaded.

Which is a real loss now rather than a theoretical one. Until this version there
was no menu or button anywhere reaching the upload form, so the module was the
only writer and republishing cost nothing. The Manuals menu makes uploading the
point, and an administrator who replaces the user manual should not find the old
one back after the next upgrade with nothing said about it.

Only the two records this module seeds. Anything an administrator created is
theirs already and has never been touched by an upgrade.
"""
import logging

_logger = logging.getLogger(__name__)

SEEDED = ('manual_app_user_guide', 'manual_module_guide')


def migrate(cr, version):
    cr.execute("""
        UPDATE ir_model_data
           SET noupdate = true
         WHERE module = 'showroom_check'
           AND name IN %s
           AND NOT noupdate
    """, (SEEDED,))
    if cr.rowcount:
        _logger.info(
            "Showroom Check: %s shipped manual(s) are now the administrator's "
            "to replace - upgrading will no longer put the bundled document "
            "back.", cr.rowcount)
