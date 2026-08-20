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
import math
import struct

from PIL import Image, ImageFilter, ImageOps

from odoo.tools.image import image_fix_orientation

_logger = logging.getLogger(__name__)

# Feature matching is optional and this module must run without it.
#
# Deliberately NOT an external_dependencies entry in the manifest: that would
# stop the module installing anywhere OpenCV is absent, and everything below
# degrades to the tile comparison that shipped before it. A site with cv2 gets
# the extra answer, a site without gets exactly what it had.
try:
    import cv2
    import numpy
except ImportError:              # pragma: no cover - depends on the host
    cv2 = None
    numpy = None
    _logger.info(
        "Showroom Check: OpenCV is not installed, so photographs are compared "
        "on tiles alone. Install opencv-python-headless to compare across "
        "cameras and distances.")


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


def _load(raw, size=THUMB, pad=False):
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
        # Two ways to make a square of it, and they are for different jobs.
        #
        # Stretched, for the tile comparison. Both sides get the identical
        # treatment, so a picture compared against itself still scores 100.
        # It does mean an original in a very different shape from the daily
        # photograph scores poorly - a real effect, and the reason the app
        # offers to take the originals with the same camera.
        #
        # Letterboxed, for feature matching, where stretching is actively
        # harmful: ORB is not affine-invariant, so squashing 4:3 into 1:1
        # leaves it matching against a shape the camera never saw. Measured on
        # two photographs of one laptop, squashed against padded, the right
        # hand view went from 41 descriptor matches to 106.
        #
        # Autocontrast BEFORE padding, in both cases. Padding first would put
        # black bars into the histogram and change how every real pixel is
        # stretched, differently for each picture depending on its shape.
        if pad:
            image = ImageOps.autocontrast(image)
            return ImageOps.pad(image, (size, size), color=0,
                                method=Image.Resampling.BILINEAR)
        image = image.resize((size, size), Image.Resampling.BILINEAR)
        return ImageOps.autocontrast(image)
    except CompareError:
        raise
    except Exception as exc:  # noqa: BLE001 - Pillow raises a wide family
        raise CompareError("This picture could not be read: %s" % exc) from exc


def padded_tile_signature(raw):
    """The tile grid in the space a registered comparison lands in.

    The warp puts today's photograph into the padded square, so the original
    has to be described there too. Stored alongside the stretched one rather
    than replacing it: the stretched grid is what the comparison falls back
    to without OpenCV, and it works.
    """
    image = _load(raw, THUMB, pad=True).filter(
        ImageFilter.GaussianBlur(BLUR_RADIUS))
    small = image.resize((GRID, GRID), Image.Resampling.BOX)
    return bytes(small.getdata())


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


def compare(reference_signature, reference_hash, capture_raw,
            reference_features=None, reference_padded=None):
    """Score today's photograph against a stored original.

    `reference_signature` is the text from `encode_signature`, `reference_hash`
    the integer from `difference_hash`, `capture_raw` the photograph's bytes,
    and `reference_features` the text from `encode_features` where there is
    one and OpenCV is installed to use it.

    Always returns a dict and never raises: a picture that cannot be read is
    something to report, not a reason to fail the upload that carried it. On
    failure `score` is None and `error` says why.

    Keys: score, tile_score, hash_score, hash_distance, hot_tiles, offset,
    match_count, inlier_count, same_view, similarity, registered, error.

    `same_view` is True, False, or None where it could not be asked - which
    is not the same as False and must not be shown as one.
    """
    blank = {'score': None, 'tile_score': None, 'hash_score': None,
             'hash_distance': None, 'hot_tiles': [], 'offset': (0, 0),
             'match_count': None, 'inlier_count': None, 'same_view': None,
             'similarity': None, 'registered': False, 'error': None}

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

    # Feature matching, where there is anything to do it with. This can only
    # add to the answer: it decides whether the two pictures are of the same
    # thing, and where the geometry is clean enough it re-scores the tiles on
    # pixels that actually correspond. A site without OpenCV, or an original
    # saved before it was installed, falls straight through with same_view
    # left at None and the tile score exactly as it was.
    matched = _match(reference_features, capture_raw)
    if matched is None:
        return result

    matches, inliers, homography = matched
    result['match_count'] = matches
    result['inlier_count'] = inliers
    result['same_view'] = matches >= MIN_SAME_VIEW_MATCHES
    result['similarity'] = similarity_from_matches(matches)

    if homography is None:
        return result

    # The warp lands in the padded square, so it can only be measured against
    # the original described in that same square. An original saved before
    # this existed has no padded grid, and registering it would be comparing
    # two different framings - so it falls back rather than guessing.
    padded_reference = decode_signature(reference_padded)
    if padded_reference is None:
        return result

    try:
        warped, coverage = _registered_tiles(capture_raw, homography)
    except CompareError:
        return result

    # Only the tiles the warp actually landed on. Anything below half
    # coverage is edge, where the resampled average is part real picture and
    # part black frame, and would read as a change that is not there.
    pairs = [(index, abs(padded_reference[index] - warped[index]))
             for index in range(GRID * GRID) if coverage[index] > 127]
    if len(pairs) < GRID:
        return result

    hot_count = max(1, int(round(len(pairs) * HOT_FRACTION)))
    ranked = sorted(pairs, key=lambda pair: pair[1], reverse=True)
    hot = ranked[:hot_count]
    hot_mean = sum(delta for _tile, delta in hot) / float(hot_count)

    registered_score = max(0, min(100, int(round(
        100.0 - min(100.0, hot_mean * DELTA_GAIN)))))
    result['score'] = registered_score
    result['tile_score'] = registered_score
    result['hot_tiles'] = sorted(tile for tile, _delta in hot)
    result['registered'] = True
    result['offset'] = (0, 0)
    return result


# ---------------------------------------------------------------------------
# Feature matching: is this even the same thing, photographed from somewhere
# else on a different phone?
#
# The tile comparison above cannot answer that and never could. It averages
# brightness over a fixed grid and forgives two tiles of shift, so moving the
# camera puts different content in every cell and the score collapses. It
# measures HOW DIFFERENT two aligned pictures are. This measures WHETHER they
# are of the same thing at all, which is a different question, and the one a
# round photographed on a different phone actually asks.
#
# Measured on the pictures that prompted it - one laptop photographed close up
# and from across the room - against four unrelated images as negatives, in
# the letterboxed square these numbers all assume:
#
#                                       matches     inliers
#   the identical file                     1964        1964
#   front original vs front round           116          29
#   right original vs right round           107          27
#   the four negatives                     4-23         4-7
#
# Two things that table decides. MATCHES separate same from different by more
# than four to one, so matches are the same-or-not signal. INLIERS are far
# tighter: a close-up and a wide shot of a real room are related by parallax
# rather than by any single homography, so RANSAC finds far fewer even where
# the descriptors plainly agree. Inliers therefore decide only whether a
# registration is worth re-scoring against - never whether the view matches.
#
# ORB_FEATURES is load-bearing and was nearly missed. At 2000 the two real
# pairs fall to 20 and 21 inliers and stop registering; at 3000 they reach 27
# and 29. At 4000 the negatives start climbing faster than the pairs do, so
# this is a peak rather than a floor - raising it further makes things worse.
#
# The floors sit between the two populations rather than on either edge:
# matches 50 against a worst pair of 107 and a best negative of 23, inliers
# 20 against 27 and 7.
#
# All of it comes from one object and a handful of pictures, and it wants
# re-measuring against real rounds.
ORB_WORK = 512               # detection runs at this size, not the tile size
ORB_FEATURES = 3000
# The ratio test: a patch only counts as matched if its best partner is this
# much better than its second best. It is a PRECISION setting, and 0.75 was
# far too loose for this subject - drawing the matches showed lines running
# from one key to a different key, and several into the bubble wrap on the
# desk. A keyboard is dozens of near-identical patches, which is exactly the
# case the ratio test exists to reject and exactly the case a slack one lets
# through.
#
# Measured as matches/inliers, with a synthesised retake as the case that
# must not break and unrelated pictures as the case that must be rejected:
#
#                      retaken original   real pair   unrelated
#   ratio .75             889 / 747        116 / 29     23,  4
#   ratio .70             718 / 628         72 / 12      8,  3
#   ratio .65             594 / 526         41 / 15      1,  1
#
# 0.65 costs nothing where it matters - a proper retake still registers on
# 526 inliers against a floor of 20 - and takes an unrelated picture from 23
# matches to 1. Separation goes from roughly five times to roughly forty.
#
# It also lowers every count, so everything calibrated against counts moves
# with it. They have to move together or the module contradicts itself.
ORB_RATIO = 0.65
MIN_SAME_VIEW_MATCHES = 15   # below this, not a picture of the same thing
MIN_REGISTER_INLIERS = 20    # below this, the homography is not worth trusting

# An inlier COUNT cannot tell a correct alignment from a confidently wrong
# one, and on a repetitive subject RANSAC produces the second kind readily:
# dozens of near-identical keys give it plenty of ways to be self-consistent
# about the wrong pairing. Both real pairs cleared 27 inliers and both were
# wrong - one squeezing the picture to a fifth of its size to fit, and the
# whole frame still differing by 49 and 66 grey levels after warping,
# where a genuine alignment sits under 20.
#
# Two things a correct homography does that a lucky one does not:
#
#   - most of its matches agree with it. 25% agreed on both wrong pairs;
#     the identical file scores 100%. 40% is comfortably between.
#   - it does not resize the picture absurdly. Anything outside a quarter
#     to four times is not two photographs of one room.
MIN_INLIER_RATIO = 0.40
MAX_REGISTER_SCALE = 4.0

# "How much of the same thing is in these two pictures", which is a different
# question from the match score and the one people actually ask when they
# look at a pair side by side. The match score answers "has this view
# changed", and it can only answer it once the two are lined up; this can
# always be answered, and it is what makes a card readable when they cannot
# be.
#
# Raw match counts span three orders of magnitude, so the scale is
# logarithmic between a floor and a ceiling taken from measurement:
#
#   the identical file                2700 matches  -> 100%
#   an original retaken from the spot  594          -> 100%
#   a close-up against a wide shot      41          ->  34%
#   unrelated pictures                   1          ->   0%
#
# The floor is MIN_SAME_VIEW_MATCHES, so anything the module calls a
# different view reads as near nothing. The ceiling is where a careful
# retake of the same view lands, so "the same picture again" reads as full.
#
# It must never be mistaken for the match score: a filthy room photographed
# from exactly the right spot is 100% similar and 0% matched, and that pair
# of numbers is the entire point of the product.
# The floor is deliberately BELOW MIN_SAME_VIEW_MATCHES rather than equal to
# it. They answer different questions: the same-view threshold is a decision
# about identity, while this is a reading of how much is shared and should
# reach zero only where nothing is.
#
# Both moved when ORB_RATIO tightened, because both are counts. Unrelated
# pictures now measure 1 match rather than 4 to 23, and a retaken original
# 594 rather than 889.
#
# Worth stating: tightening the ratio LOWERED the reading for the pair that
# prompted all of this, from 46% to 34%, because two thirds of the matches
# it was counted from were false. The smaller number is the true one.
SIMILARITY_FLOOR = 10.0
SIMILARITY_CEILING = 600.0


def similarity_from_matches(matches):
    """Descriptor matches -> a percentage a person can read."""
    if not matches or matches <= SIMILARITY_FLOOR:
        return 0
    span = math.log(SIMILARITY_CEILING / SIMILARITY_FLOOR)
    reached = math.log(float(matches) / SIMILARITY_FLOOR)
    return int(round(min(100.0, 100.0 * reached / span)))

# How far a matched point may sit from where the homography puts it, in
# pixels of the ORB_WORK square. 12 is about 2.3% of the frame - the error a
# person reshooting a room by hand actually leaves behind. 5, the usual
# default, assumes a tripod.
#
# Measured across both levers at once, on the two real pairs and an unrelated
# picture as a negative, as matches/inliers:
#
#                            front       right      negative
#   squashed, 5            132 / 18     41 /  7      22 / 9
#   squashed, 12           132 / 35     41 / 11      22 / 10
#   padded,   12           127 / 34    106 / 27      25 / 9
#
# Both real pairs clear MIN_REGISTER_INLIERS on the last row and the negative
# does not move. Loosening ORB_RATIO to 0.85 was tried and rejected: it lifts
# the negative to 31 inliers, which would register a logo against a laptop.
RANSAC_REPROJECTION = 12.0


def orb_features(raw):
    """Keypoints and descriptors for one picture, or None.

    Taken from the normalised square, the same picture the tile signature
    comes from, so the two describe one image rather than two.
    """
    if cv2 is None:
        return None
    try:
        array = numpy.asarray(_load(raw, ORB_WORK, pad=True))
    except CompareError:
        return None
    detector = cv2.ORB_create(nfeatures=ORB_FEATURES)
    keypoints, descriptors = detector.detectAndCompute(array, None)
    if descriptors is None or len(keypoints) < 2:
        return None
    return numpy.float32([kp.pt for kp in keypoints]), descriptors


def encode_features(features):
    """(points, descriptors) -> text, for storing in a Text column.

    A four byte header and two raw buffers, rather than a pickle or a JSON
    list of floats: this is a few thousand numbers written once and read on
    every round, and it must never be able to execute anything on the way
    back in.
    """
    if not features:
        return None
    points, descriptors = features
    count, width = descriptors.shape
    blob = (struct.pack("<HH", count, width)
            + points.astype("<f4").tobytes()
            + descriptors.tobytes())
    return base64.b64encode(blob).decode("ascii")


def decode_features(text):
    """Text -> (points, descriptors). None for anything that does not fit."""
    if not text or cv2 is None:
        return None
    try:
        blob = base64.b64decode(text)
        count, width = struct.unpack_from("<HH", blob, 0)
        if count < 2 or width == 0 or len(blob) != 4 + count * 8 + count * width:
            return None
        points = numpy.frombuffer(blob, "<f4", count * 2, 4).reshape(count, 2)
        descriptors = numpy.frombuffer(
            blob, numpy.uint8, count * width, 4 + count * 8).reshape(count, width)
        return points, descriptors
    except (ValueError, TypeError, struct.error):
        return None


def _match(reference_features, capture_raw):
    """Match today's photograph against an original's stored descriptors.

    Returns (matches, inliers, homography), or None where the comparison
    could not be attempted at all. The homography is None whenever it could
    not be fitted or is not worth trusting; the counts still mean something
    in that case and are what answers same-or-not.
    """
    reference = decode_features(reference_features)
    if reference is None:
        return None
    capture = orb_features(capture_raw)
    if capture is None:
        return None

    ref_points, ref_descriptors = reference
    cap_points, cap_descriptors = capture

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    good = []
    for pair in matcher.knnMatch(cap_descriptors, ref_descriptors, k=2):
        if len(pair) == 2 and pair[0].distance < ORB_RATIO * pair[1].distance:
            good.append(pair[0])
    if len(good) < 4:
        return len(good), 0, None

    source = numpy.float32(
        [cap_points[m.queryIdx] for m in good]).reshape(-1, 1, 2)
    target = numpy.float32(
        [ref_points[m.trainIdx] for m in good]).reshape(-1, 1, 2)
    homography, mask = cv2.findHomography(
        source, target, cv2.RANSAC, RANSAC_REPROJECTION)
    inliers = int(mask.sum()) if mask is not None else 0
    if homography is None or inliers < MIN_REGISTER_INLIERS:
        return len(good), inliers, None
    if inliers < len(good) * MIN_INLIER_RATIO:
        return len(good), inliers, None
    if not _plausible_homography(homography):
        return len(good), inliers, None
    return len(good), inliers, homography


def _plausible_homography(homography):
    """Does this transform describe two photographs of one room?

    The determinant of the linear part is the area scale. A correct
    registration of a room reshot by hand is somewhere near 1; a wrong one
    found among repeating detail is free to be anything, and one of the two
    that prompted this check came back at 0.215 - squeezing the photograph
    to a fifth of its size to make the keys line up.
    """
    try:
        determinant = abs(float(numpy.linalg.det(homography[:2, :2])))
    except (ValueError, TypeError, numpy.linalg.LinAlgError):
        return False
    if determinant <= 0:
        return False
    scale = determinant ** 0.5
    return 1.0 / MAX_REGISTER_SCALE <= scale <= MAX_REGISTER_SCALE


def _registered_tiles(capture_raw, homography):
    """Today's picture warped into the original's frame, and its coverage.

    The coverage matters. A warp leaves part of the frame empty, and an empty
    tile measured against the original reads as the largest difference there
    is - inventing a change exactly where there is no evidence either way.
    Those tiles are dropped rather than counted.
    """
    array = numpy.asarray(_load(capture_raw, ORB_WORK, pad=True))
    warped = cv2.warpPerspective(array, homography, (ORB_WORK, ORB_WORK))
    covered = cv2.warpPerspective(
        numpy.full((ORB_WORK, ORB_WORK), 255, numpy.uint8), homography,
        (ORB_WORK, ORB_WORK))

    picture = Image.fromarray(warped).resize(
        (THUMB, THUMB), Image.Resampling.BILINEAR)
    picture = picture.filter(ImageFilter.GaussianBlur(BLUR_RADIUS))
    tiles = bytes(picture.resize((GRID, GRID), Image.Resampling.BOX).getdata())

    cover = Image.fromarray(covered).resize((GRID, GRID), Image.Resampling.BOX)
    return tiles, bytes(cover.getdata())


# How many lines the drawing shows before it stops being readable. A
# hundred crossing lines hide the thing they are drawn to show, so the
# strongest are drawn by default and the rest are a click away - withheld
# for legibility, never to make the picture agree with the number.
DRAWN_MATCHES = 40


def match_drawing(reference_raw, capture_raw, everything=False):
    """The two pictures side by side with the matches drawn between them.

    The count on the card is evidence, and this is what the evidence looks
    like: one line per matched pair, so a number somebody doubts can be
    counted instead of trusted. Same principle the module already applies
    to the score - a disputed answer has to be recomputable and showable to
    whoever disputes it.

    Coloured by agreement rather than uniformly. A line drawn green agrees
    with the transform most of the others describe; an amber one does not.
    On a pair that failed to register the amber lines ARE the explanation,
    so colouring them turns a tangle into the reason.

    Returns PNG bytes, or None where there is nothing to draw.
    """
    if cv2 is None:
        return None
    try:
        left = numpy.asarray(_load(reference_raw, ORB_WORK, pad=True))
        right = numpy.asarray(_load(capture_raw, ORB_WORK, pad=True))
    except CompareError:
        return None

    detector = cv2.ORB_create(nfeatures=ORB_FEATURES)
    kp_left, des_left = detector.detectAndCompute(left, None)
    kp_right, des_right = detector.detectAndCompute(right, None)
    if des_left is None or des_right is None:
        return None

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    good = []
    for pair in matcher.knnMatch(des_right, des_left, k=2):
        if len(pair) == 2 and pair[0].distance < ORB_RATIO * pair[1].distance:
            good.append(pair[0])
    if not good:
        return None

    # Which of them agree with each other. Not the registration decision -
    # that is stricter and lives in _match - just enough of a fit to sort
    # the coherent bundle from the strays for the eye.
    agreed = set()
    if len(good) >= 4:
        source = numpy.float32(
            [kp_right[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        target = numpy.float32(
            [kp_left[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        _homography, mask = cv2.findHomography(
            source, target, cv2.RANSAC, RANSAC_REPROJECTION)
        if mask is not None:
            agreed = {index for index, keep in enumerate(mask.ravel()) if keep}

    # Strongest first, so the ones drawn by default are the ones with the
    # most behind them.
    order = sorted(range(len(good)), key=lambda i: good[i].distance)
    if not everything:
        order = order[:DRAWN_MATCHES]

    canvas = cv2.drawMatches(
        right, kp_right, left, kp_left, [], None,
        flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS)
    offset = right.shape[1]

    # Drawn by hand rather than through drawMatches, which paints every
    # line one colour and offers no way to say which of them agree.
    for index in order:
        match = good[index]
        x1, y1 = kp_right[match.queryIdx].pt
        x2, y2 = kp_left[match.trainIdx].pt
        colour = (120, 220, 120) if index in agreed else (60, 170, 245)
        start = (int(round(x1)), int(round(y1)))
        end = (int(round(x2)) + offset, int(round(y2)))
        cv2.line(canvas, start, end, colour, 1, cv2.LINE_AA)
        cv2.circle(canvas, start, 3, colour, 1, cv2.LINE_AA)
        cv2.circle(canvas, end, 3, colour, 1, cv2.LINE_AA)

    ok, buffer = cv2.imencode(".png", canvas)
    return buffer.tobytes() if ok else None


def signature_for(raw):
    """Everything precomputed for one original, or Nones if unreadable.

    Returns (signature, phash, features, padded_signature). Called when an
    original is saved,
    so the cost of decoding it is paid once by the manager rather than every
    day by every round - which is the whole reason the descriptors are
    stored here rather than derived at comparison time.

    `features` is None wherever OpenCV is absent. That is not an error and
    must not be treated as one: the tile comparison still works.
    """
    try:
        signature = encode_signature(tile_signature(raw))
        padded = encode_signature(padded_tile_signature(raw))
        phash = difference_hash(raw)
    except CompareError as exc:
        _logger.warning("Showroom Check: could not prepare an original - %s", exc)
        return None, None, None, None
    return signature, phash, encode_features(orb_features(raw)), padded
