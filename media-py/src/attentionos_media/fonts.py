"""Fonts for captions and graphics. Only OFL fonts (Montserrat, Geist, Instrument Serif, Caveat), fetched into the
cache by `models download fonts` with checksums and license fields. When a font is not downloaded yet, Pillow's
built-in scalable font is used so renders still work (and QC still runs) on a fresh machine."""

from __future__ import annotations

from functools import cache
from pathlib import Path

from PIL import ImageFont

from .models import artifact_path, installed

FAMILY_ARTIFACT = {
    "montserrat": "font-montserrat",
    "geist": "font-geist",
    "instrument-serif": "font-instrument-serif",
    "caveat": "font-caveat",
}


def _path(family: str, italic: bool) -> Path | None:
    name = FAMILY_ARTIFACT.get(family, "font-geist")
    if family == "instrument-serif" and italic and installed("font-instrument-serif-italic"):
        return artifact_path("font-instrument-serif-italic")
    return artifact_path(name) if installed(name) else None


@cache
def font(
    family: str, size: int, weight: int = 700, italic: bool = False
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    size = max(6, int(size))
    p = _path(family, italic)
    if p is None:
        return ImageFont.load_default(size)
    f = ImageFont.truetype(str(p), size)
    try:  # variable fonts: pick the weight on the wght axis
        axes = f.get_variation_axes()
        if axes:
            lo, hi = axes[0]["minimum"], axes[0]["maximum"]
            f.set_variation_by_axes([max(lo, min(hi, weight))])
    except OSError:
        pass
    return f


def fonts_available() -> dict[str, bool]:
    return {fam: installed(art) for fam, art in FAMILY_ARTIFACT.items()}
