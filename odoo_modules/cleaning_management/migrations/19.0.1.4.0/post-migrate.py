"""Strip codec parameters from stored video attachment mimetypes.

Recordings made before 19.0.1.4.0 stored the browser's full MediaRecorder type
(e.g. "video/mp4;codecs=avc1.42e01e") on the attachment. That value is sent
verbatim as the Content-Type header, alongside X-Content-Type-Options: nosniff,
which left browsers refusing to show a video player for it.

Only the attachment is corrected. cleaning.recording.mimetype deliberately keeps
the full string - it never becomes a header and is useful diagnostic detail.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return

    cr.execute("""
        UPDATE ir_attachment
           SET mimetype = split_part(mimetype, ';', 1)
         WHERE res_model = 'cleaning.recording'
           AND res_field = 'video_file'
           AND mimetype LIKE '%;%'
    """)
    if cr.rowcount:
        _logger.info(
            "cleaning_management: cleaned the Content-Type on %s stored "
            "recording(s) so browsers will play them", cr.rowcount)
