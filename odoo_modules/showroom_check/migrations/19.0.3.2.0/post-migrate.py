"""Repair the false "the original has been replaced" warning.

reference_replaced used to compare the reference RECORD's write_date against
the date a round stamped when it was photographed. Any write to the row - a
rename, an edit to the instructions, or the 19.0.3.1.0 migration adding feature
descriptors - therefore claimed the picture had been replaced. It had not.

The comparison now runs against image_write_date, which only moves when the
photograph itself does. Two things need backfilling for that to be true of
everything already stored:

  * every original needs an image_write_date, taken from its image attachment,
    which is the only honest record of when the picture last changed;
  * every round that stamped the row's write_date needs its copy corrected to
    the same figure, or it will keep comparing against a date that meant
    something else.

Rounds photographed against an original that has genuinely been replaced since
keep their warning: their stamp is older than the attachment, and stays older.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    # Straight SQL. These are two columns on at most a handful of rows per
    # company, and going through the ORM would fire the image resize, the
    # signature and the descriptors again for no reason at all.
    cr.execute("""
        UPDATE cleaning_reference_image AS r
           SET image_write_date = a.write_date
          FROM ir_attachment AS a
         WHERE a.res_model = 'cleaning.reference.image'
           AND a.res_field = 'image'
           AND a.res_id = r.id
           AND r.image_write_date IS NULL
    """)
    originals = cr.rowcount

    # Only the stamps that are now in the future relative to the picture, which
    # is exactly the set that was written from the row rather than the image.
    cr.execute("""
        UPDATE cleaning_recording_shot AS s
           SET reference_write_date = r.image_write_date
          FROM cleaning_reference_image AS r
         WHERE s.reference_image_id = r.id
           AND r.image_write_date IS NOT NULL
           AND s.reference_write_date > r.image_write_date
    """)
    shots = cr.rowcount

    _logger.info(
        "Showroom Check: dated %s originals from their picture and corrected "
        "%s rounds that had been told the original changed when it had not.",
        originals, shots)
