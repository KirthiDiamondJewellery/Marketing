"""Programmatic graphics drawn with PIL: headline, lower-third, post-card, screenshot, logo and chart overlays.
Generic, brand-neutral designs: dark cards, white type, one accent colour (plan `props.accent` overrides).
Every graphic is laid out inside the UI-safe box. Entrance animation: a short pop (scale + fade); charts grow
their bars. `draw_overlay` returns the box it used so QC can check it."""

from __future__ import annotations

import textwrap
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

from ..errors import MediaError
from ..fonts import font
from ..schemas import Overlay
from .safezone import Box

CARD = (14, 14, 18, 236)
WHITE = (255, 255, 255)
MUTED = (170, 170, 182)
ACCENT = (255, 214, 10)
POP_FRAMES = 5
CHART_FRAMES = 14


def hex_rgb(value: str | None, default: tuple[int, int, int] = ACCENT) -> tuple[int, int, int]:
    if not value or not isinstance(value, str) or not value.startswith("#") or len(value) not in (4, 7):
        return default
    v = value[1:]
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    try:
        return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    except ValueError:
        return default


@dataclass
class OverlayCtx:
    w: int
    h: int
    box: Box
    assets: dict[str, str]  # assetId -> local path
    caption_top: int  # y where captions start (graphics stay above it unless placed lower on purpose)


def anim_steps(ov: Overlay) -> int:
    return CHART_FRAMES if ov.kind == "chart" else POP_FRAMES


def _wrap(d: ImageDraw.ImageDraw, text: str, f, max_w: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if d.textbbox((0, 0), trial, font=f)[2] <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]


def _fit_text(text: str, family: str, weight: int, size: int, max_w: int, max_lines: int, min_size: int = 30):
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    while True:
        f = font(family, size, weight)
        lines = _wrap(probe, text, f, max_w)
        if len(lines) <= max_lines or size <= min_size:
            return f, lines[:max_lines] if size > min_size else lines, size
        size = int(size * 0.9)


def _line_h(f) -> int:
    a, d = f.getmetrics() if hasattr(f, "getmetrics") else (20, 5)
    return a + d


def _shadowed(card: Image.Image, radius: int = 18) -> Image.Image:
    pad = radius * 2
    out = Image.new("RGBA", (card.width + 2 * pad, card.height + 2 * pad), (0, 0, 0, 0))
    alpha = card.split()[-1].point(lambda a: int(a * 0.55))
    shadow = Image.new("RGBA", card.size, (0, 0, 0, 255))
    shadow.putalpha(alpha)
    out.alpha_composite(shadow, (pad, pad + 8))
    out = out.filter(ImageFilter.GaussianBlur(radius))
    out.alpha_composite(card, (pad, pad))
    return out


@cache
def _load_image(path: str) -> Image.Image:
    p = Path(path)
    if not p.exists():
        raise MediaError(
            "asset_missing",
            f"Overlay image not found: {p.name}",
            "Re-attach the asset or remove the overlay from the plan.",
        )
    im = Image.open(p)
    im = ImageOps.exif_transpose(im) or im
    return im.convert("RGBA")


def _rounded(im: Image.Image, r: int) -> Image.Image:
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius=r, fill=255)
    out = im.copy()
    out.putalpha(Image.composite(im.split()[-1], mask, mask) if im.mode == "RGBA" else mask)
    return out


# --- builders: each returns an RGBA card (unanimated) or a function of progress for charts ---------------------


def headline(ov: Overlay, ctx: OverlayCtx) -> Image.Image:
    accent = hex_rgb(ov.props.get("accent"))
    upper = ov.props.get("upper", True)
    text = (ov.text or "").strip()
    text = text.upper() if upper else text
    max_w = ctx.box.width - 80
    f, lines, size = _fit_text(text, "montserrat", 900, 78, max_w, 3)
    lh = int(_line_h(f) * 1.02)
    sub = (ov.subtext or "").strip()
    fs = font("geist", max(28, size // 2), 600)
    sub_lines = _wrap(ImageDraw.Draw(Image.new("RGBA", (8, 8))), sub, fs, max_w) if sub else []
    h = 44 + lh * len(lines) + (12 + _line_h(fs) * len(sub_lines) if sub_lines else 0) + 36
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    w = min(ctx.box.width, max(probe.textbbox((0, 0), ln, font=f)[2] for ln in lines) + 80)
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=30, fill=CARD)
    d.rounded_rectangle((28, h - 18, 28 + min(160, w // 3), h - 10), radius=4, fill=(*accent, 255))
    y = 26
    hl = {t.lower() for t in ov.props.get("highlight", [])} if isinstance(ov.props.get("highlight"), list) else set()
    for ln in lines:
        x = 40
        for word in ln.split(" "):
            color = accent if word.lower().strip(".,!?") in hl else WHITE
            d.text((x, y), word, font=f, fill=color)
            x += d.textbbox((0, 0), word + " ", font=f)[2]
        y += lh
    if sub_lines:
        y += 12
        for ln in sub_lines:
            d.text((40, y), ln, font=fs, fill=MUTED)
            y += _line_h(fs)
    return card


def lower_third(ov: Overlay, ctx: OverlayCtx) -> Image.Image:
    accent = hex_rgb(ov.props.get("accent"))
    name = (ov.text or "").strip()
    role = (ov.subtext or "").strip()
    fn, fr = font("geist", 52, 800), font("geist", 34, 500)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    w = min(
        ctx.box.width,
        max(probe.textbbox((0, 0), name, font=fn)[2], probe.textbbox((0, 0), role, font=fr)[2] if role else 0) + 76,
    )
    h = 30 + _line_h(fn) + (_line_h(fr) + 6 if role else 0) + 24
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=22, fill=CARD)
    d.rounded_rectangle((0, 0, 12, h - 1), radius=6, fill=(*accent, 255))
    d.text((40, 24), name, font=fn, fill=WHITE)
    if role:
        d.text((40, 30 + _line_h(fn)), role, font=fr, fill=MUTED)
    return card


def post_card(ov: Overlay, ctx: OverlayCtx) -> Image.Image:
    """A generic social-post card (no platform branding): avatar initial, name, handle, body, optional stats."""
    p = ov.props
    dark = p.get("theme", "light") == "dark"
    bg, fg, sub = ((22, 22, 26, 245), WHITE, MUTED) if dark else ((255, 255, 255, 250), (15, 15, 20), (100, 100, 112))
    w = min(ctx.box.width, 860)
    body = (ov.text or "").strip()
    fb = font("geist", 44, 500)
    lines = _wrap(ImageDraw.Draw(Image.new("RGBA", (8, 8))), body, fb, w - 96)[:8]
    stats = [str(s) for s in p.get("stats", [])][:3] if isinstance(p.get("stats"), list) else []
    h = 48 + 92 + 28 + _line_h(fb) * len(lines) + (70 if stats else 0) + 40
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=34, fill=bg)
    author = str(p.get("author") or ov.subtext or "Author")
    accent = hex_rgb(p.get("accent"), (90, 120, 255))
    d.ellipse((48, 48, 140, 140), fill=(*accent, 255))
    fi = font("geist", 46, 800)
    initial = author[:1].upper()
    iw = d.textbbox((0, 0), initial, font=fi)[2]
    d.text((94 - iw / 2, 64), initial, font=fi, fill=WHITE)
    d.text((164, 54), author, font=font("geist", 40, 750), fill=fg)
    if p.get("handle"):
        d.text((164, 100), str(p["handle"]), font=font("geist", 32, 500), fill=sub)
    y = 48 + 92 + 28
    for ln in lines:
        d.text((48, y), ln, font=fb, fill=fg)
        y += _line_h(fb)
    if stats:
        y += 20
        fx = font("geist", 32, 600)
        x = 48
        for s in stats:
            d.text((x, y), s, font=fx, fill=sub)
            x += d.textbbox((0, 0), s, font=fx)[2] + 48
    return card


def screenshot(ov: Overlay, ctx: OverlayCtx) -> Image.Image:
    if not ov.asset_id or ov.asset_id not in ctx.assets:
        raise MediaError(
            "asset_missing",
            f"Screenshot overlay at {ov.at:.1f}s has no asset.",
            "Attach the screenshot asset or remove the overlay.",
        )
    im = _load_image(ctx.assets[ov.asset_id])
    max_w, max_h = ctx.box.width, int(ov.props.get("maxHeight", 900))
    s = min(max_w / im.width, max_h / im.height, 1.0 if ov.props.get("noUpscale") else 10.0)
    im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.Resampling.LANCZOS)
    card = _rounded(im, 26)
    source = ov.props.get("source")
    if source:
        fs = font("geist", 28, 650)
        probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
        tw = probe.textbbox((0, 0), str(source), font=fs)[2]
        chip_h = _line_h(fs) + 16
        out = Image.new("RGBA", (card.width, card.height + chip_h + 12), (0, 0, 0, 0))
        out.alpha_composite(card)
        d = ImageDraw.Draw(out)
        d.rounded_rectangle((0, card.height + 12, tw + 32, card.height + 12 + chip_h), radius=chip_h // 2, fill=CARD)
        d.text((16, card.height + 20), str(source), font=fs, fill=WHITE)
        card = out
    return card


def logo(ov: Overlay, ctx: OverlayCtx) -> Image.Image:
    if not ov.asset_id or ov.asset_id not in ctx.assets:
        raise MediaError(
            "asset_missing",
            f"Logo overlay at {ov.at:.1f}s has no asset.",
            "Attach the logo asset or remove the overlay.",
        )
    im = _load_image(ctx.assets[ov.asset_id])
    size = int(ov.props.get("size", 180))
    s = min(size / im.width, size / im.height)
    return im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.Resampling.LANCZOS)


def chart(ov: Overlay, ctx: OverlayCtx, progress: float) -> Image.Image:
    p = ov.props
    labels = [str(x) for x in p.get("labels", [])]
    values = [float(v) for v in p.get("values", [])]
    if not labels or len(labels) != len(values):
        raise MediaError(
            "bad_overlay", f"Chart at {ov.at:.1f}s needs props.labels and props.values of the same length."
        )
    accent = hex_rgb(p.get("accent"))
    hi = p.get("highlight")
    unit = str(p.get("unit", ""))
    w = min(ctx.box.width, 860)
    title = (ov.text or p.get("title") or "").strip()
    ft, fl, fv = font("montserrat", 50, 850), font("geist", 30, 600), font("geist", 34, 750)
    title_lines = textwrap.wrap(title, 26)[:2] if title else []
    n = len(values)
    row_h = 74
    h = 40 + _line_h(ft) * len(title_lines) + 24 + n * row_h + (50 if p.get("source") else 0) + 30
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=30, fill=CARD)
    y = 34
    for ln in title_lines:
        d.text((40, y), ln, font=ft, fill=WHITE)
        y += _line_h(ft)
    y += 24
    vmax = max(max(values), 1e-9)
    label_w = min(260, max(d.textbbox((0, 0), lb, font=fl)[2] for lb in labels) + 20)
    bar_x0, bar_x1 = 40 + label_w, w - 150
    ease = 1 - (1 - min(1.0, max(0.0, progress))) ** 3
    for i, (lb, v) in enumerate(zip(labels, values, strict=True)):
        d.text((40, y + 18), lb, font=fl, fill=MUTED)
        bw = int((bar_x1 - bar_x0) * (v / vmax) * ease)
        color = accent if (hi is None or hi in (i, lb)) else (110, 110, 124)
        d.rounded_rectangle((bar_x0, y + 12, bar_x0 + max(bw, 6), y + row_h - 16), radius=10, fill=(*color, 255))
        val = f"{v:g}{unit}"
        d.text((bar_x0 + max(bw, 6) + 14, y + 16), val, font=fv, fill=WHITE)
        y += row_h
    if p.get("source"):
        d.text((40, y + 10), f"Source: {p['source']}", font=font("geist", 26, 500), fill=MUTED)
    return card


BUILDERS = {
    "headline": headline,
    "lower-third": lower_third,
    "post-card": post_card,
    "screenshot": screenshot,
    "logo": logo,
}


def placement(ov: Overlay, card: Image.Image, ctx: OverlayCtx) -> tuple[int, int]:
    pos = ov.position or {"headline": "top", "lower-third": "lower", "logo": "top"}.get(ov.kind, "top")
    if ov.kind == "logo":
        corner = ov.props.get("corner", "top-left")
        x = ctx.box.left + 10 if "left" in corner else ctx.box.right - card.width - 10
        return x, ctx.box.top + 10
    x = (ctx.w - card.width) // 2
    x = max(ctx.box.left, min(x, ctx.box.right - card.width))
    if pos == "top":
        y = ctx.box.top + 10
    elif pos == "middle":
        y = (ctx.h - card.height) // 2
    else:
        y = ctx.caption_top - card.height - 30
        if ov.kind == "lower-third":
            x = ctx.box.left + 10
    y = max(ctx.box.top, min(y, ctx.box.bottom - card.height))
    return x, y


class OverlayRenderer:
    """Caches each overlay's base card; animation frames are derived from it."""

    def __init__(self, ctx: OverlayCtx):
        self.ctx = ctx
        self._cards: dict[int, Image.Image] = {}
        self._shadowed: dict[int, Image.Image] = {}

    def draw(self, canvas: Image.Image, idx: int, ov: Overlay, step: int) -> tuple[int, int, int, int]:
        steps = anim_steps(ov)
        if ov.kind == "chart":
            card = chart(ov, self.ctx, step / steps)
        else:
            if idx not in self._cards:
                self._cards[idx] = BUILDERS[ov.kind](ov, self.ctx)
            card = self._cards[idx]
        x, y = placement(ov, card, self.ctx)
        bbox = (x, y, x + card.width, y + card.height)
        if ov.kind != "chart" and step < steps:
            p = (step + 1) / (steps + 1)
            s = 0.86 + 0.14 * (1 - (1 - p) ** 3)
            nw, nh = max(1, int(card.width * s)), max(1, int(card.height * s))
            frame = card.resize((nw, nh), Image.Resampling.BILINEAR)
            a = frame.split()[-1].point(lambda v: int(v * min(1.0, 0.35 + p)))
            frame.putalpha(a)
            canvas.alpha_composite(frame, (x + (card.width - nw) // 2, y + (card.height - nh) // 2))
        elif ov.kind in ("logo", "chart"):
            canvas.alpha_composite(card, (x, y))
        else:
            if idx not in self._shadowed:
                self._shadowed[idx] = _shadowed(card, 18)
            canvas.alpha_composite(self._shadowed[idx], (x - 36, y - 36))
        return bbox
