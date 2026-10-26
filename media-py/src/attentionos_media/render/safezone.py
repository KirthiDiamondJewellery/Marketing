"""UI-safe boxes for vertical video (1080×1920 reference). Platforms draw their UI over the top band (tabs, camera
icon), the bottom ~20% (handle, caption, audio) and a right-side button column. Captions and graphics must sit
inside the safe box; video itself may extend everywhere.

Values are for a 1080×1920 frame and scale linearly to other export sizes. `universal` is the intersection of
the platform boxes and is the default.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..schemas import SafeZone

REF_W, REF_H = 1080, 1920

PRESETS: dict[str, tuple[int, int, int, int]] = {
    # margins from each edge: top, bottom, left, right (pixels in a 1080×1920 frame); mirrors SAFE_ZONE_MARGINS in
    # packages/media/src/edit-plan.ts
    "reels": (220, 384, 60, 140),
    "tiktok": (240, 440, 60, 160),
    "shorts": (200, 420, 60, 150),
    "universal": (240, 440, 60, 160),
}


@dataclass(frozen=True)
class Box:
    top: int
    bottom: int
    left: int
    right: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    def contains(self, x0: float, y0: float, x1: float, y1: float, tol: float = 0.5) -> bool:
        return x0 >= self.left - tol and y0 >= self.top - tol and x1 <= self.right + tol and y1 <= self.bottom + tol

    def to_json(self) -> dict:
        return {"top": self.top, "bottom": self.bottom, "left": self.left, "right": self.right}


def safe_box(zone: SafeZone | None, w: int = REF_W, h: int = REF_H) -> Box:
    """The safe box for a frame: preset margins (scaled from 1080×1920), overridden by explicit margins (pixels, or
    fractions of the frame when ≤ 1)."""
    top, bottom, left, right = PRESETS[(zone.preset if zone else "universal")]
    sx, sy = w / REF_W, h / REF_H

    def px(v: float | None, fallback: int, dim: int, scale: float) -> int:
        if v is None:
            return round(fallback * scale)
        return round(v * dim) if v <= 1 else round(v)

    t = px(zone.top if zone else None, top, h, sy)
    b = px(zone.bottom if zone else None, bottom, h, sy)
    lf = px(zone.left if zone else None, left, w, sx)
    r = px(zone.right if zone else None, right, w, sx)
    return Box(t, h - b, lf, w - r)
