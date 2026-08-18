"""Comparing today's photograph against the original, without an AI.

Plain functions and no ORM, for the same reason `cleaning_ai_provider` is
written that way: this is the part most likely to need tuning, and it can be
exercised from a shell with two JPEGs and no database at all.

Why this exists alongside the AI review rather than instead of it:

* it returns the same number every time, so a threshold means something and a
  disputed warning can be recomputed and shown to the person disputing it;
* it works with AI review switched off, which is how it ships by default;
* nothing leaves the building to produce it.

What it deliberately does not do is explain itself. "The bags are missing from
the left side" is a sentence only the AI can write. This module answers "how
different"; the AI answers "different how".

Pillow only, no numpy. There are 256 tiles, arithmetic over 256 numbers is
measured in microseconds, and numpy is not a dependency of this platform.
"""
import base64
import io
import logging

from PIL import Image, ImageFilter, ImageOps

from odoo.tools.image import image_fix_orientation

_logger = logging.getLogger(__name__)


# The grid the picture is chopped into. 16x16 = 256 tiles on a 256px thumbnail,
# so one tile is 16x16 pixels of thumbnail and roughly a sixteenth of the width
# of the room.
GRID = 16
THUMB = GRID * 16

# Only the worst 5% of tiles (13 of 256) decide the score.
#
# This is the most important choice in the file. Averaging the whole frame is
# the obvious thing to do and it is useless here: a bag removed from one corner
# touches maybe eight tiles out of 256, so a whole-frame average still reads in
# the nineties and a threshold at 60 would never once fire. The feature exists
# to catch a localised change, so the score has to be decided by the region
# that changed rather than diluted by the nine-tenths of the room that did not.
HOT_FRACTION = 0.05

# Grayscale levels of difference mapped straight onto points of penalty,
# saturating at 100. Chosen against how photographs of one room actually
# behave: the same room hours apart, after autocontrast, differs by roughly
# 8-20 levels in its worst tiles, which lands at 80-92. Something genuinely
# missing pushes its tiles past 60 levels, which lands below 40. That
# separation is what the whole feature depends on, which is why this is a named
# constant and not a number buried in an expression.
DELTA_GAIN = 1.0

# dHash on a 9x8 grid: 64 bits of "is this even the same view".
HASH_SIZE = 8

# Nobody stands in exactly the same place two days running, and the comparison
# has to survive that or it reports a warning every single day.
#
# BLUR_RADIUS softens the picture by half a tile before the tiles are averaged,
# which absorbs movement smaller than one tile. MAX_SHIFT_TILES then slides the
# two grids over each other and keeps the best-fitting alignment, which absorbs
# movement larger than one tile.
#
# Both are needed, and dropping either one breaks it. Measured on the same
# room photographed from a standing position moved by a percentage of the frame
# width, against the same room with a bag removed:
#
#                              shift 1%   shift 5%   shift 10%   bag removed
#   blur + alignment              76         70         41            0
#   alignment only, no blur       58         48          0            0
#   blur only, no alignment       76          0          0            0
#   neither                       58          0          0            0
#
# Without the blur a one-percent shift already scores 58 - a warning, on a room
# where nothing whatever had moved. Without the alignment a five-percent shift
# scores zero. Neither of them costs anything in detection: a removed bag still
# scores 0 in all four columns.
#
# The alignment search is global - one offset for the whole picture - and that
# is deliberate. Letting each tile hunt for its own best match would let a
# removed bag pair itself with the floor beside it and disappear from the
# score, which is the one thing this must never do.
BLUR_RADIUS = (THUMB / GRID) / 2.0
MAX_SHIFT_TILES = 2


class CompareError(Exception):
    """A photograph could not be read. Never fatal - see `compare`."""


def _load(raw):
    """Raw bytes -> upright, grayscale, contrast-normalised thumbnail.

    Orientation is fixed first because a phone writes the picture the way the
    sensor saw it and records which way up it was held in a tag. Two
    photographs of one room, the phone held a little differently, would
    otherwise compare as two completely different rooms.

    Autocontrast afterwards, because the room is lit differently at 09:00 and
    at 18:00 and nobody wants that reported as somebody having moved a chair.
    It stretches both pictures to the same tonal range, so the comparison is
    about what is in the room rather than what the sun was doing.
    """
    if not raw:
        raise CompareError("There is no picture to compare.")
    try:
        image = Image.open(io.BytesIO(raw))
        image = image_fix_orientation(image)
        image = image.convert('L')
        # Stretched to a square rather than letterboxed. Both sides get the
        # identical treatment, so a picture compared against itself still
        # scores 100. It does mean an original in a very different shape from
        # the daily photograph scores poorly - which is a real effect, and the
        # reason the app offers to take the originals with the same camera.
        image = image.resize((THUMB, THUMB), Image.Resampling.BILINEAR)
        return ImageOps.autocontrast(image)
    except CompareError:
        raise
    except Exception as exc:  # noqa: BLE001 - Pillow raises a wide family
        raise CompareError("This picture could not be read: %s" % exc) from exc


def tile_signature(raw):
    """One average brightness per tile, as GRID*GRID bytes.

    Stored against the original, so a daily round only decodes the four
    photographs that just arrived and never the four it compares them with.
    """
    image = _load(raw).filter(ImageFilter.GaussianBlur(BLUR_RADIUS))
    small = image.resize((GRID, GRID), Image.Resampling.BOX)
    return bytes(small.getdata())


def difference_hash(raw):
    """A 64-bit dHash: is this even a picture of the same view?

    Kept beside the tile score but deliberately not the headline. It is the
    coarse sanity signal - it catches a phone pointed at the ceiling, or an
    entirely different room - and it is the number to look at when the tile
    score says something surprising.
    """
    image = _load(raw)
    small = image.resize((HASH_SIZE + 1, HASH_SIZE), Image.Resampling.BILINEAR)
    pixels = list(small.getdata())
    bits = 0
    for row in range(HASH_SIZE):
        offset = row * (HASH_SIZE + 1)
        for col in range(HASH_SIZE):
            bits <<= 1
            if pixels[offset + col] > pixels[offset + col + 1]:
                bits |= 1
    return bits


def encode_signature(signature):
    """Tile bytes -> text, for storing in a Char column."""
    return base64.b64encode(signature).decode('ascii')


def decode_signature(text):
    """Text -> tile bytes. None for anything unreadable or the wrong length."""
    if not text:
        return None
    try:
        raw = base64.b64decode(text)
    except (ValueError, TypeError):
        return None
    return raw if len(raw) == GRID * GRID else None


def hamming(left, right):
    return bin(left ^ right).count('1')


def _aligned_deltas(reference, capture):
    """Slide the two tile grids over each other and keep the best fit.

    Returns ``(deltas_by_capture_tile, (dx, dy))``, where the deltas cover only
    the tiles the two grids have in common at that offset.

    One offset for the whole picture, chosen by lowest mean difference. That is
    what a person standing half a step to the left looks like, and it is
    exactly what should be forgiven. Twenty-five offsets over 256 tiles is a
    few thousand subtractions, so this costs nothing worth measuring.
    """
    best = None
    for dy in range(-MAX_SHIFT_TILES, MAX_SHIFT_TILES + 1):
        for dx in range(-MAX_SHIFT_TILES, MAX_SHIFT_TILES + 1):
            pairs = []
            total = 0
            for y in range(GRID):
                ry = y + dy
                if not 0 <= ry < GRID:
                    continue
                for x in range(GRID):
                    rx = x + dx
                    if not 0 <= rx < GRID:
                        continue
                    delta = abs(reference[ry * GRID + rx] - capture[y * GRID + x])
                    pairs.append((y * GRID + x, delta))
                    total += delta
            if not pairs:
                continue
            mean = total / float(len(pairs))
            if best is None or mean < best[0]:
                best = (mean, pairs, (dx, dy))
    if best is None:                                  # unreachable with GRID > 2
        return [], (0, 0)
    return best[1], best[2]


def compare(reference_signature, reference_hash, capture_raw):
    """Score today's photograph against a stored original.

    `reference_signature` is the text from `encode_signature`, `reference_hash`
    the integer from `difference_hash`, `capture_raw` the photograph's bytes.

    Always returns a dict and never raises: a picture that cannot be read is
    something to report, not a reason to fail the upload that carried it. On
    failure `score` is None and `error` says why.

    Keys: score, tile_score, hash_score, hash_distance, hot_tiles, offset,
    error.
    """
    blank = {'score': None, 'tile_score': None, 'hash_score': None,
             'hash_distance': None, 'hot_tiles': [], 'offset': (0, 0),
             'error': None}

    reference = decode_signature(reference_signature)
    if reference is None:
        return dict(blank, error="The original for this view has not been prepared yet.")

    try:
        capture = tile_signature(capture_raw)
    except CompareError as exc:
        return dict(blank, error=str(exc))

    pairs, offset = _aligned_deltas(reference, capture)
    if not pairs:
        return dict(blank, error="These two pictures could not be lined up.")

    # Worst-region, not whole-frame. See HOT_FRACTION.
    hot_count = max(1, int(round(len(pairs) * HOT_FRACTION)))
    ranked = sorted(pairs, key=lambda pair: pair[1], reverse=True)
    hot = ranked[:hot_count]
    hot_mean = sum(delta for _tile, delta in hot) / float(hot_count)

    tile_score = int(round(100.0 - min(100.0, hot_mean * DELTA_GAIN)))
    tile_score = max(0, min(100, tile_score))

    result = dict(blank, score=tile_score, tile_score=tile_score,
                  hot_tiles=sorted(tile for tile, _delta in hot),
                  offset=offset)

    if reference_hash is not None:
        try:
            distance = hamming(int(reference_hash), difference_hash(capture_raw))
        except (CompareError, TypeError, ValueError):
            return result
        result['hash_distance'] = distance
        result['hash_score'] = int(round(100.0 - (distance / 64.0 * 100.0)))

    return result


def signature_for(raw):
    """Both precomputed values for one original, or (None, None) if unreadable.

    Called when an original is saved, so the cost of decoding it is paid once
    by the manager rather than every day by every round.
    """
    try:
        return encode_signature(tile_signature(raw)), difference_hash(raw)
    except CompareError as exc:
        _logger.warning("Showroom Check: could not prepare an original - %s", exc)
        return None, None
