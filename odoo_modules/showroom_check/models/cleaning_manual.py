import base64
import os

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError
from odoo.modules.module import get_module_path


class CleaningManual(models.Model):
    """The guides behind the Help screen, in the backend and in the app.

    Each document is read in two steps: a guide, written as HTML and readable
    on any screen, and behind it the full PDF for whoever wants the whole
    thing. The guide is what people actually read; the PDF is what they keep.

    Two shelves, kept apart by `section`: the module's own documentation, and
    how to use the app. They are one model rather than two because everything
    else about them is identical, and the only question that differs is which
    heading it appears under.

    Held in the database so a document can be replaced without shipping a new
    build of the app, and without anyone touching the server's filesystem --
    except for guides deliberately shipped with the module, which is what the
    two `*_static_path` fields are for.
    """

    _name = 'cleaning.manual'
    _description = 'Showroom Check Manual'
    # Admin-controlled order within a section, then newest last.
    _order = 'section, sequence, id'
    _rec_name = 'name'

    name = fields.Char(string='Title', required=True)
    description = fields.Char(
        string='Description',
        help="One line under the title on the card. What this guide answers.",
    )
    icon = fields.Char(
        string='Icon',
        default='📄',
        help="Emoji shown on the card, so a shelf can be read at a glance.",
    )

    # --- The guide ------------------------------------------------------------
    # sanitize=False because this is written by a manager, not submitted by a
    # visitor, and sanitising strips the layout out of a pasted guide.
    html_content = fields.Html(string='Guide', sanitize=False)
    html_static_path = fields.Char(
        string='Static HTML Path',
        help="For guides shipped inside a module, e.g. "
             "showroom_check/static/src/docs/rounds_guide.html. Used only when "
             "no Guide has been written above.",
    )

    # --- The document itself --------------------------------------------------
    pdf_file = fields.Binary(string='PDF', attachment=True)
    pdf_filename = fields.Char(string='Filename')
    pdf_static_path = fields.Char(
        string='Static PDF URL',
        help="For PDFs shipped inside a module, e.g. "
             "/showroom_check/static/src/docs/rounds.pdf. An uploaded PDF wins "
             "over this.",
    )
    pdf_url = fields.Char(string='PDF URL', compute='_compute_pdf_url')

    section = fields.Selection(
        [('manual', 'User manual'), ('app', 'Mobile app')],
        string='Section',
        default='app',
        required=True,
        help="Which heading this appears under in Help. User manual: the module "
             "itself. Mobile app: using the app.",
    )
    # Only meaningful on the Mobile app shelf -- see _visible_to_caller. The
    # module's manual is one shelf everybody shares.
    audience = fields.Selection(
        [('user', 'Users'), ('manager', 'Managers')],
        string='Shown to',
        default='user',
        required=True,
        help="Mobile app guides only. Users: everyone who signs into the app. "
             "Managers: only the people who run the rounds, and administrators.",
    )
    sequence = fields.Integer(string='Sequence', default=10)
    active = fields.Boolean(string='Active', default=True)

    @api.depends('pdf_file', 'pdf_filename', 'pdf_static_path')
    def _compute_pdf_url(self):
        for rec in self:
            # An upload wins over a bundled path, so replacing the PDF actually
            # changes what the button opens.
            if rec.pdf_file:
                rec.pdf_url = '/web/content/cleaning.manual/%s/pdf_file/%s?download=false' % (
                    rec.id, rec.pdf_filename or 'document.pdf')
            elif rec.pdf_static_path:
                rec.pdf_url = rec.pdf_static_path
            else:
                rec.pdf_url = False

    @api.constrains('pdf_file', 'pdf_filename')
    def _check_pdf_only(self):
        """Refuse anything that is not a PDF.

        The extension is checked because it is what people see, but the file's
        own header is what decides: a renamed .exe passes an extension test and
        fails this one. Only the first bytes are decoded -- there is no reason
        to pull a whole document into memory to read five characters.
        """
        for rec in self:
            if not rec.pdf_file:
                continue
            if not (rec.pdf_filename or '').lower().endswith('.pdf'):
                raise ValidationError(_("Only PDF files can be uploaded here."))
            try:
                header = base64.b64decode(rec.pdf_file[:12])
            except Exception as exc:  # noqa: BLE001 - any decode failure is a bad file
                raise ValidationError(_("That file could not be read as a PDF.")) from exc
            if not header.startswith(b'%PDF-'):
                raise ValidationError(
                    _("That file is not a PDF, whatever its name says."))

    # --- App-facing methods ---------------------------------------------------

    def _caller_is_manager(self):
        """Managers see both audiences; everyone else sees only their own.

        base.group_system implies the manager group (see cleaning_groups.xml),
        so an administrator needs no special case here.
        """
        return self.env.user.has_group('showroom_check.group_cleaning_manager')

    def _visible_to_caller(self, record):
        """May this person see this document?

        Only the Mobile app shelf is split by audience. The module's manual is
        for everybody, so a stale `audience` left on one of those records can
        never hide it -- the rule lives here rather than in the data.
        """
        if record.section != 'app':
            return True
        return record.audience != 'manager' or self._caller_is_manager()

    def _read_static_file(self, path):
        """Read a bundled guide body, given a `module/relative/path`.

        Guarded on purpose: the path comes from a field, and joining it blindly
        would let anyone with write access read any file the server can.
        """
        if not path:
            return ''
        parts = path.lstrip('/').split('/', 1)
        if len(parts) != 2:
            return ''
        module, relative = parts
        base = get_module_path(module)
        if not base:
            return ''
        full = os.path.normpath(os.path.join(base, *relative.split('/')))
        # normpath resolves any '..' in the field; refuse whatever climbs out.
        if not full.startswith(os.path.normpath(base) + os.sep):
            return ''
        try:
            if os.path.isfile(full):
                with open(full, 'r', encoding='utf-8') as handle:
                    return handle.read()
        except OSError:
            pass
        return ''

    @api.model
    def get_manuals(self):
        """Every document this person may open, metadata only.

        One call fills the whole Help screen: each row says which section it
        belongs to, so the app splits them locally rather than asking twice.
        Neither the guide nor the bytes are included -- a PDF is megabytes of
        base64, and a shelf is drawn from titles alone.

        A document with a guide but no PDF still counts: the guides can be
        written and read long before anyone gets round to the PDFs.

        sudo() because the library is shared: a cleaner has no record rule
        granting them a document somebody else uploaded, and should not need
        one. The filtering below is what decides, not the ACL.
        """
        domain = ['|', ('pdf_file', '!=', False), ('html_content', '!=', False)]
        if not self._caller_is_manager():
            domain += ['|', ('section', '=', 'manual'), ('audience', '=', 'user')]
        return [{
            'id': rec.id,
            'name': rec.name or 'Manual',
            'description': rec.description or '',
            'icon': rec.icon or '📄',
            'filename': rec.pdf_filename or (rec.name or 'Manual') + '.pdf',
            'section': rec.section,
            'audience': rec.audience,
            'has_pdf': bool(rec.pdf_file),
        } for rec in self.sudo().search(domain)]

    @api.model
    def get_guide(self, manual_id):
        """One document's guide: the body HTML, and whether a PDF sits behind it.

        The body only. The backend wraps it in a page with a button that opens
        the PDF in a tab; the app wraps it in a screen with a button that hands
        back to native code. Same words, two shells, because the app has no
        session cookie to open a URL with.
        """
        record = self.sudo().browse(int(manual_id)).exists()
        if not record or not self._visible_to_caller(record):
            return False
        return {
            'id': record.id,
            'name': record.name or 'Manual',
            'html': record.html_content or self._read_static_file(record.html_static_path) or '',
            'has_pdf': bool(record.pdf_file),
        }

    @api.model
    def get_manual(self, manual_id):
        """One document's PDF as base64, or ``False``.

        The audience is checked again rather than trusted from the list: this
        takes an id from the client, and a filtered list is not a permission.
        """
        record = self.sudo().browse(int(manual_id)).exists()
        if not record or not record.pdf_file:
            return False
        if not self._visible_to_caller(record):
            return False
        data = record.pdf_file
        if isinstance(data, bytes):
            data = data.decode()
        return {
            'id': record.id,
            'name': record.name or 'Manual',
            'filename': record.pdf_filename or 'Manual.pdf',
            'data': data,
        }
