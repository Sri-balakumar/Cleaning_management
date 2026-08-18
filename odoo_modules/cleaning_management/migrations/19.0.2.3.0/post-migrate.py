"""Re-assert the Manager group for administrators.

`base.group_system` implies `group_cleaning_manager`, which is the only thing
granting Manager - the module ships no `res.users` record. That implication is
applied once, when the link is first created, and `(4, ...)` is a no-op on every
upgrade afterwards. So an administrator who loses the group never gets it back.

Losing it is easy: both groups hang off one `res.groups.privilege`, which renders
as a single exclusive selector on the user form (No access / User / Manager).
Saving an administrator with "User" chosen drops Manager, and the Configuration
menu disappears with it while Record and Recordings stay put - which is exactly
the symptom this exists to repair.

Written against the relation table rather than the ORM on purpose: the groups
many2many on res.users was renamed in the 19.0 group refactor, while
res_groups_users_rel(gid, uid) has been stable for many versions.
"""
import logging

_logger = logging.getLogger(__name__)

GROUPS = ('group_cleaning_manager', 'group_cleaning_user')


def migrate(cr, version):
    if not version:
        return

    granted = 0
    for name in GROUPS:
        cr.execute(
            """
            INSERT INTO res_groups_users_rel (gid, uid)
            SELECT grp.res_id, sys_member.uid
              FROM ir_model_data grp
              JOIN ir_model_data sys_grp
                ON sys_grp.module = 'base'
               AND sys_grp.name = 'group_system'
               AND sys_grp.model = 'res.groups'
              JOIN res_groups_users_rel sys_member
                ON sys_member.gid = sys_grp.res_id
             WHERE grp.module = 'cleaning_management'
               AND grp.name = %s
               AND grp.model = 'res.groups'
               AND NOT EXISTS (
                     SELECT 1
                       FROM res_groups_users_rel existing
                      WHERE existing.gid = grp.res_id
                        AND existing.uid = sys_member.uid
                   )
            """,
            (name,),
        )
        granted += cr.rowcount

    if granted:
        _logger.info(
            "cleaning_management: restored %s cleaning group membership(s) for "
            "administrators, bringing the Configuration menu back",
            granted,
        )
