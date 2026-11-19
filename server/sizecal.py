"""Size calibration: a test plate to print, the maths from its measurements,
and the corrections the slicer applies for each filament.

The plate is an L: an X arm 120 mm long and a Y arm 100 mm long, both 20 mm
wide and 3 mm thick, with four holes in the X arm (5, 10 and 14 mm round and
an 11 mm hex, measured across the flats).  It is sliced with no corrections,
so what the owner measures is what the printer really does.

From the measurements:
  scale  (each axis)  the part prints this many times its size: from the long
                      and short sizes on the same axis (120/20 on X, 100/20 on Y)
  outside             walls sit this far out from where they should, per side,
                      after the scale is fixed (+ = outsides too big)
  hole_fit            how much bigger across holes must be drawn, once the
                      slicer has fixed scale and outsides (SnorbCAD's printer fit)

At slice time the model is scaled by 1/scale in X and Y (about each part's own
centre) and PrusaSlicer's xy_size_compensation is set to -outside.
"""
import json
import math
import os
import struct
import time

CELL, THICK, SUB = 20.0, 3.0, 8        # cell size, plate thickness, points per cell side
X_CELLS, Y_CELLS = 6, 5                # X arm 120 mm, Y arm 100 mm (sharing the corner cell)
HOLES = {1: ("round", 5.0), 2: ("round", 10.0), 3: ("hex", 11.0), 4: ("round", 14.0)}

# What the owner measures: key -> (label, the size it should be)
MEASURES = {
    "x_len":   ("X arm, end to end", 120.0),
    "y_width": ("Y arm, across (left to right)", 20.0),
    "y_len":   ("Y arm, end to end", 100.0),
    "x_width": ("X arm, across (front to back)", 20.0),
    "hole5":   ("5 mm hole", 5.0),
    "hole10":  ("10 mm hole", 10.0),
    "hex11":   ("Hex hole, across the flats", 11.0),
    "hole14":  ("14 mm hole", 14.0),
}
HOLE_KEYS = ("hole5", "hole10", "hex11", "hole14")

# Beyond these, a number was most likely misread or mistyped.
MAX_SCALE_ERR = 0.03        # 3 %
MAX_OUTSIDE = 0.4           # mm per side
MAX_HOLE_FIT = 1.5          # mm across


class CalError(ValueError):
    pass


# ------------------------------------------------------------------ the plate

def _cells():
    """(i, j) of every cell in the L."""
    cells = {(i, 0) for i in range(X_CELLS)} | {(0, j) for j in range(Y_CELLS)}
    return sorted(cells)


def _boundary(i, j):
    """The cell's edge, anticlockwise from its lower-left corner, SUB points
    per side.  Neighbours share exactly the same points on a shared side."""
    x0, y0, s = i * CELL, j * CELL, CELL / SUB
    pts = [(x0 + k * s, y0) for k in range(SUB)]
    pts += [(x0 + CELL, y0 + k * s) for k in range(SUB)]
    pts += [(x0 + CELL - k * s, y0 + CELL) for k in range(SUB)]
    pts += [(x0, y0 + CELL - k * s) for k in range(SUB)]
    return pts


def _hole(i, j, kind, size):
    """The hole's edge, anticlockwise, centred in the cell."""
    cx, cy = (i + 0.5) * CELL, (j + 0.5) * CELL
    if kind == "hex":
        r = size / 2 / math.cos(math.pi / 6)        # across the flats -> corner radius
        return [(cx + r * math.cos(math.pi / 3 * k), cy + r * math.sin(math.pi / 3 * k))
                for k in range(6)]
    n = 96
    return [(cx + size / 2 * math.cos(2 * math.pi * k / n),
             cy + size / 2 * math.sin(2 * math.pi * k / n)) for k in range(n)]


def _ring(outer, inner, c):
    """Triangles filling between two loops that both go anticlockwise round
    the centre c (each loop seen as a star from c), anticlockwise faces."""
    def ang(p, a0):
        return (math.atan2(p[1] - c[1], p[0] - c[0]) - a0) % (2 * math.pi)
    a0 = math.atan2(outer[0][1] - c[1], outer[0][0] - c[0])
    oa = [0.0] + [ang(p, a0) or 2 * math.pi for p in outer[1:]] + [2 * math.pi]
    start = min(range(len(inner)), key=lambda k: ang(inner[k], a0))
    inner = inner[start:] + inner[:start]
    ia = [ang(p, a0) for p in inner]
    ia = ia + [ia[0] + 2 * math.pi]
    O, I = outer + [outer[0]], inner + [inner[0]]
    tris, i, j = [], 0, 0
    while i < len(outer) or j < len(inner):
        if j == len(inner) or (i < len(outer) and oa[i + 1] <= ia[j + 1]):
            tris.append((O[i], O[i + 1], I[j]))
            i += 1
        else:
            tris.append((O[i], I[j + 1], I[j]))
            j += 1
    return tris


def plate_triangles(x_off=0.0, y_off=0.0):
    """The test plate as triangles (each three (x, y, z) points, outward-facing)."""
    cells = set(_cells())
    out = []

    def lift(p, z):
        return (p[0] + x_off, p[1] + y_off, z)

    def caps(t2):
        for a, b, c in t2:
            out.append((lift(a, THICK), lift(b, THICK), lift(c, THICK)))   # top, faces up
            out.append((lift(a, 0), lift(c, 0), lift(b, 0)))               # bottom, faces down

    def wall(p, q, outward=True):
        b0, b1, t0, t1 = lift(p, 0), lift(q, 0), lift(p, THICK), lift(q, THICK)
        if outward:
            out.extend([(b0, b1, t1), (b0, t1, t0)])
        else:
            out.extend([(b0, t1, b1), (b0, t0, t1)])

    for (i, j) in sorted(cells):
        edge = _boundary(i, j)
        c = ((i + 0.5) * CELL, (j + 0.5) * CELL)
        hole = HOLES.get(i) if j == 0 else None
        if hole:
            loop = _hole(i, j, *hole)
            caps(_ring(edge, loop, c))
            for k in range(len(loop)):
                wall(loop[k], loop[(k + 1) % len(loop)], outward=False)
        else:
            caps([(edge[k], edge[(k + 1) % len(edge)], c) for k in range(len(edge))])
        # outside walls where there is no neighbour
        sides = [((i, j - 1), 0), ((i + 1, j), 1), ((i, j + 1), 2), ((i - 1, j), 3)]
        for nb, side in sides:
            if nb in cells:
                continue
            for k in range(SUB):
                n = side * SUB + k
                wall(edge[n], edge[(n + 1) % len(edge)])
    return out


def write_stl(path, tris):
    with open(path, "wb") as f:
        f.write(b"SnorbStudio size test".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            u = [b[k] - a[k] for k in range(3)]
            v = [c[k] - a[k] for k in range(3)]
            n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            ln = math.sqrt(sum(x * x for x in n)) or 1.0
            f.write(struct.pack("<12fH", *(x / ln for x in n), *a, *b, *c, 0))


def plate_stl(path, bed=(235.0, 235.0)):
    """Write the plate, centred on the bed."""
    w, d = X_CELLS * CELL, Y_CELLS * CELL
    write_stl(path, plate_triangles((bed[0] - w) / 2, (bed[1] - d) / 2))


# ------------------------------------------------------------------ the maths

def compute(m):
    """Corrections from the measurements (a dict of MEASURES keys -> mm)."""
    try:
        got = {k: float(m[k]) for k in MEASURES}
    except (KeyError, TypeError, ValueError):
        missing = [MEASURES[k][0] for k in MEASURES if not _number(m.get(k))]
        raise CalError("Fill in every measurement (missing: %s)." % ", ".join(missing))
    for k, (label, want) in MEASURES.items():
        if abs(got[k] - want) > max(1.5, want * 0.05):
            raise CalError("%s reads %.2f mm but should be about %g. Check that one."
                           % (label, got[k], want))

    def axis(long_key, short_key):
        L, S = MEASURES[long_key][1], MEASURES[short_key][1]
        s = (got[long_key] - got[short_key]) / (L - S)
        o = (got[long_key] - s * L) / 2
        return s, o

    sx, ox = axis("x_len", "y_width")
    sy, oy = axis("y_len", "x_width")
    outside = (ox + oy) / 2
    s = (sx + sy) / 2
    short = {k: s * MEASURES[k][1] - got[k] for k in HOLE_KEYS}   # how much small, across
    hole_fit = sum(short.values()) / len(short) - 2 * outside
    for name, val in (("X", sx), ("Y", sy)):
        if abs(val - 1) > MAX_SCALE_ERR:
            raise CalError("The %s size is off by %.1f %%, more than a calibration "
                           "should fix. Re-check the arm lengths." % (name, (val - 1) * 100))
    if abs(outside) > MAX_OUTSIDE:
        raise CalError("The outsides are off by %.2f mm per side, more than expected. "
                       "Re-check the arm widths." % outside)
    if not -0.2 <= hole_fit <= MAX_HOLE_FIT:
        raise CalError("The holes come out %.2f mm off, which doesn't look right. "
                       "Re-check the hole sizes." % hole_fit)
    return {
        "sx": round(sx, 5), "sy": round(sy, 5),
        "outside": round(outside, 3),
        "hole_fit": round(max(0.0, hole_fit), 2),
        "holes": {k: round(v, 3) for k, v in short.items()},
        "measured": got,
    }


def _number(v):
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


# ------------------------------------------------------------------ storage

class Store:
    """Saved calibrations, one per filament, in a small JSON file."""

    def __init__(self, path):
        self.path = path

    def all(self):
        try:
            with open(self.path) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def get(self, material):
        return self.all().get(material)

    def save(self, material, result):
        data = self.all()
        data[material] = dict(result, date=time.strftime("%Y-%m-%d"))
        tmp = self.path + ".tmp"
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(tmp, "w") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, self.path)
        return data[material]

    def forget(self, material):
        data = self.all()
        if data.pop(material, None) is not None:
            with open(self.path, "w") as f:
                json.dump(data, f, indent=1)


# ------------------------------------------------------------------ applying it

def scale_stl(path, fx, fy):
    """Scale a binary STL by fx, fy about the centre of its own X/Y extent.
    Returns False (file untouched) if it isn't a binary STL."""
    with open(path, "rb") as f:
        data = bytearray(f.read())
    if len(data) < 84:
        return False
    n = struct.unpack_from("<I", data, 80)[0]
    if len(data) != 84 + 50 * n or n == 0:
        return False
    xs, ys = [], []
    for t in range(n):
        o = 84 + 50 * t + 12
        for v in range(3):
            x, y = struct.unpack_from("<2f", data, o + 12 * v)
            xs.append(x)
            ys.append(y)
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    for t in range(n):
        o = 84 + 50 * t + 12
        for v in range(3):
            p = o + 12 * v
            x, y = struct.unpack_from("<2f", data, p)
            struct.pack_into("<2f", data, p, cx + (x - cx) * fx, cy + (y - cy) * fy)
    with open(path, "wb") as f:
        f.write(data)
    return True


def apply(cal, stl_paths, cfg):
    """Fix a slice job with a saved calibration: scale the models, and set the
    outside offset unless the owner typed their own Hole/size fix."""
    if not cal:
        return
    fx, fy = 1 / cal["sx"], 1 / cal["sy"]
    if abs(fx - 1) > 1e-5 or abs(fy - 1) > 1e-5:
        for p in stl_paths:
            scale_stl(p, fx, fy)
    if "xy_size_compensation" not in cfg:
        cfg["xy_size_compensation"] = round(-cal["outside"], 3)
