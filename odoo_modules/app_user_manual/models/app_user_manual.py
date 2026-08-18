from odoo import _, api, models, fields


class AppUserManual(models.Model):
    _name = 'app.user.manual'
    _description = 'App User Manual'
    # mail.thread powers the chatter on the form so admins can audit who
    # uploaded / replaced / removed which manual document and when.
    _inherit = ['mail.thread']
    # Admin-controlled display order in the app, then newest last.
    _order = 'sequence, id'
    _rec_name = 'name'

    name = fields.Char(string='Title', required=True, tracking=True)
    pdf_file = fields.Binary(
        string='Manual PDF',
        attachment=True,
        tracking=True,
    )
    pdf_filename = fields.Char(string='Filename')
    sequence = fields.Integer(string='Sequence', default=10)
    active = fields.Boolean(string='Active', default=True, tracking=True)

    def name_get(self):
        # Keep the breadcrumb / picker readable even before a title is typed.
        return [(rec.id, rec.name or _('Document #%s') % rec.id) for rec in self]

    # --- App-facing methods ----------------------------------------------------

    @api.model
    def get_manuals(self):
        """App-facing list of available manual documents (metadata only).

        Returns a list of ``{'id', 'name', 'filename'}`` for every active
        document that actually has a PDF — WITHOUT the bytes, so the list is
        light. The app then calls ``get_manual(id)`` for the one the user
        opens. When the module is not installed the RPC errors and the app
        treats it as "no manuals". Uses sudo() so any logged-in user can read
        the shared library regardless of record rules.
        """
        records = self.sudo().search([('pdf_file', '!=', False)])
        return [{
            'id': rec.id,
            'name': rec.name or 'User Manual',
            'filename': rec.pdf_filename or (rec.name or 'User Manual') + '.pdf',
        } for rec in records]

    @api.model
    def get_manual(self, manual_id):
        """App-facing read: one document's PDF as base64.

        Returns ``{'id', 'name', 'filename', 'data'}`` (``data`` is a base64
        string) for the given id, or ``False`` when it is missing / empty.
        """
        record = self.sudo().browse(int(manual_id)).exists()
        if not record or not record.pdf_file:
            return False
        data = record.pdf_file
        if isinstance(data, bytes):
            data = data.decode()
        return {
            'id': record.id,
            'name': record.name or 'User Manual',
            'filename': record.pdf_filename or 'User Manual.pdf',
            'data': data,
        }
