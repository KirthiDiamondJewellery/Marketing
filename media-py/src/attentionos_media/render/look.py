"""The automatic look: one `lutyuv` table built from statistics measured on the whole source (analysis.py), so
every take gets the same correction and nothing flickers.

- Levels: the 0.5th/99.5th luma percentiles are pulled toward black and white (never more than 35% gain, never
  crushing more than a few code values), then a gamma moves the median toward a comfortable mid-grey.
- White balance: grey-world on mid-tone, low-saturation pixels, applied as small U/V offsets (capped).
- Grades: `pop` and `vivid` add contrast and saturation, `warm`/`cool` shift the balance, `mono` drops colour.
`strength` scales every automatic correction. A source that is already fine gets no filter at all (faster).
"""

from __future__ import annotations

import math

from ..schemas import Look

GRADES = {
    # contrast, saturation, u offset, v offset
    "none": (1.0, 1.0, 0.0, 0.0),
    "pop": (1.06, 1.08, 0.0, 0.0),
    "vivid": (1.08, 1.15, 0.0, 0.0),
    "warm": (1.02, 1.04, -3.0, 3.0),
    "cool": (1.02, 1.0, 3.0, -2.0),
    "mono": (1.05, 0.0, 0.0, 0.0),
}


def look_params(look: Look, stats: dict) -> dict | None:
    if look.color == "off" and look.grade == "none":
        return None
    k = look.strength if look.color == "auto" else 0.0
    lo, hi, mid = stats.get("lumaP0_5", 0.0), stats.get("lumaP99_5", 255.0), stats.get("lumaP50", 118.0)
    # Black and white points (full-range 0..255), moved by `strength`, with caps.
    b = min(lo, 24.0) * k
    w = 255.0 - (255.0 - max(hi, 189.0)) * k
    if (w - b) < 255 / 1.35:  # cap the stretch
        w = b + 255 / 1.35
    norm_mid = min(0.95, max(0.05, (mid - b) / max(1.0, w - b)))
    target = 0.46
    # Already comfortable (within 0.07 of the target): leave the mid-tones alone.
    gamma = 1.0 if abs(norm_mid - target) < 0.07 else 1.0 + (math.log(target) / math.log(norm_mid) - 1.0) * k
    gamma = min(1.25, max(0.8, gamma))
    r, g, bl = stats.get("neutralRgb", [128.0, 128.0, 128.0])
    y = 0.2126 * r + 0.7152 * g + 0.0722 * bl
    cb = (bl - y) / 1.8556 * 224 / 255
    cr = (r - y) / 1.5748 * 224 / 255
    du = max(-6.0, min(6.0, -cb * 0.8)) * k
    dv = max(-6.0, min(6.0, -cr * 0.8)) * k
    con, sat, gu, gv = GRADES[look.grade]
    params = {"black": b, "white": w, "gamma": gamma, "contrast": con, "saturation": sat, "du": du + gu, "dv": dv + gv}
    trivial = (
        b < 1.5
        and w > 253.5
        and abs(gamma - 1) < 0.02
        and con == 1.0
        and sat == 1.0
        and abs(params["du"]) < 0.75
        and abs(params["dv"]) < 0.75
    )
    return None if trivial else params


def lutyuv_expr(p: dict) -> str:
    """The filter arguments for `lutyuv=` (limited-range YUV in and out)."""
    scale = 255 / 219
    rng = max(1.0, p["white"] - p["black"])
    y = (
        f"16+219*clip(0.5+(pow(clip(((val-16)*{scale:.5f}-{p['black']:.3f})/{rng:.3f},0,1),{p['gamma']:.4f})-0.5)"
        f"*{p['contrast']:.4f},0,1)"
    )
    u = f"clip(128+(val-128)*{p['saturation']:.4f}+{p['du']:.3f},16,240)"
    v = f"clip(128+(val-128)*{p['saturation']:.4f}+{p['dv']:.3f},16,240)"
    return f"y='{y}':u='{u}':v='{v}'"
