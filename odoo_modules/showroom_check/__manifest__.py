{
    'name': 'Showroom Check',
    'version': '19.0.3.9.0',
    'category': 'Operations',
    'summary': 'Scheduled photo check that a showroom matches its agreed layout',
    'description': """
Showroom Check
==============

Proof-of-visit for office cleaning staff.

An administrator configures how many cleaning rounds happen per day and the time
window for each one (morning 09:00-10:00, afternoon 14:00-15:00, evening,
night). On the Cleaning dashboard a **Record** button is enabled *only* while a
window is open; pressing it records a short clip from the webcam and stores it
against that slot for that day.

Configurable by the administrator:

* how many rounds per day, and the start/end time of each
* the recording duration (seconds / minutes / hours)
* the video quality (480p / 720p / 1080p) and format (WebM / MP4)
* which users are allowed to record
* how long recordings are kept before they are deleted automatically

One recording per slot per day. A Manager deleting a recording re-opens that
slot.

Requires HTTPS
--------------
Browsers refuse camera access on pages served over plain HTTP. The dashboard
detects this and explains it. See ``doc/README.md`` for the reverse-proxy setup.
    """,
    'author': 'Alphalize Technologies',
    'website': 'https://www.alphalize.com',
    'license': 'LGPL-3',
    # Deliberately minimal. This is NOT an hr/attendance module: it does not
    # need employees, contracts or payroll, and adding `hr` would drag a large
    # dependency tree into a database that may not want it.
    'depends': ['base', 'web'],
    # Load order is load-bearing: the privilege/groups must exist before the
    # ACL csv references them, the ACLs before the record rules, and the menu
    # last so every action it points at already exists.
    'data': [
        'security/cleaning_groups.xml',
        'security/ir.model.access.csv',
        'security/cleaning_record_rules.xml',
        # Client actions first: the settings form has a button pointing at the
        # camera test action, so the action has to exist by the time the form
        # is parsed.
        'views/cleaning_dashboard_action.xml',
        'views/cleaning_config_views.xml',
        'views/cleaning_slot_views.xml',
        'views/cleaning_recording_views.xml',
        'views/cleaning_comparison_views.xml',
        'views/cleaning_compare_result_views.xml',
        'views/cleaning_slot_missed_views.xml',
        'views/cleaning_ai_views.xml',
        'views/cleaning_manual_views.xml',
        # Deliberately NO res.config.settings extension. Inheriting the shared
        # settings form makes Odoo revalidate every other module's additions to
        # it, so one unrelated stale view anywhere in the database blocks this
        # module from installing. The settings have their own menu under
        # Cleaning > Configuration, which is where people look anyway.
        'views/menu.xml',
        # Last: the record points at files under static/ and needs the model
        # loaded, so it can only be read once everything above has been.
        'data/cleaning_manual_data.xml',
    ],
    'assets': {
        # Both .js and .xml go here - Odoo 19 has no separate assets_qweb
        # bundle. Never `import` the .xml from a .js; that breaks the whole
        # backend bundle.
        'web.assets_backend': [
            'showroom_check/static/src/**/*',
        ],
        'web.assets_unit_tests': [
            'showroom_check/static/tests/**/*',
        ],
    },
    'images': ['static/description/icon.png'],
    'post_init_hook': '_post_init_seed_config',
    'installable': True,
    'application': True,
    'auto_install': False,
}
