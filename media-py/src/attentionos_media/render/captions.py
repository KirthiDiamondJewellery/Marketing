"""Burned-in captions from word timings. Words come from the plan in SOURCE time and are mapped to OUTPUT frames
through the time map before anything else happens. A caption chunk is 1–7 words (1–3 for the reel styles); the
spoken word is highlighted word by word (`activeColor`, the house style's brand colour), emphasis words are bolder
and/or coloured, and every chunk is laid out inside the UI-safe box (font shrinks to fit, never drawn into the
bottom ~20% or the right-side button column).

Rendering: each distinct caption state (chunk, active word, pop step) is drawn once with PIL into a band of the
frame and cached by content; ffmpeg overlays the band at its y. This works with any ffmpeg build (no libass needed)
and costs a few hundred small PNGs per minute instead of a full-frame layer per state."""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, field, replace

from PIL import Image, ImageDraw, ImageFilter

from ..fonts import font
from ..schemas import Captions, Word
from ..timemap import TimeMap
from .safezone import Box


@dataclass(frozen=True)
class CaptionStyle:
    family: str
    weight: int
    size: int
    max_words: int
    max_chars: int
    case: str  # upper | as-is | lower
    stroke: int
    shadow: bool
    box: tuple[int, int, int, int] | None  # RGBA background box
    text: tuple[int, int, int]
    active: tuple[int, int, int] | None
    emphasis: tuple[int, int, int]
    emphasis_weight: int
    emphasis_italic: bool
    pop: bool
    dim_upcoming: bool


STYLES: dict[str, CaptionStyle] = {
    "bold-pop": CaptionStyle(
        "montserrat",
        900,
        92,
        3,
        16,
        "upper",
        9,
        False,
        None,
        (255, 255, 255),
        (255, 214, 10),
        (61, 220, 151),
        900,
        False,
        True,
        False,
    ),
    # Word-by-word: the spoken word in the accent colour; emphasis words go bolder (white), not a second colour.
    "clean": CaptionStyle(
        "geist",
        650,
        66,
        3,
        22,
        "as-is",
        0,
        True,
        None,
        (255, 255, 255),
        (255, 214, 10),
        (255, 255, 255),
        850,
        False,
        False,
        False,
    ),
    "subtitle": CaptionStyle(
        "geist", 550, 48, 7, 36, "as-is", 0, True, None, (255, 255, 255), None, (255, 214, 10), 750, False, False, False
    ),
    "boxed": CaptionStyle(
        "geist",
        700,
        56,
        5,
        26,
        "as-is",
        0,
        False,
        (255, 255, 255, 240),
        (15, 15, 18),
        None,
        (200, 30, 30),
        800,
        False,
        False,
        False,
    ),
    "serif": CaptionStyle(
        "instrument-serif",
        400,
        84,
        4,
        22,
        "as-is",
        0,
        True,
        None,
        (255, 255, 255),
        None,
        (255, 255, 255),
        400,
        True,
        False,
        False,
    ),
}

POP_FRAMES = 4


def _core(token: str) -> str:
    return re.sub(r"[^\w']+", "", token.lower())


@dataclass
class CapWord:
    text: str
    start: int  # output frame
    end: int
    emphasis: bool


@dataclass
class Chunk:
    words: list[CapWord]
    start: int
    end: int
    index: int = 0


@dataclass
class CaptionTrack:
    style: CaptionStyle | None
    chunks: list[Chunk] = field(default_factory=list)
    center_y: int = 1250
    box: Box | None = None
    _starts: list[int] = field(default_factory=list, repr=False)

    def state_at(self, frame: int) -> tuple | None:
        """Hashable description of what is on screen at `frame` (None = no caption)."""
        if not self.style or not self.chunks:
            return None
        if len(self._starts) != len(self.chunks):
            self._starts = [c.start for c in self.chunks]
        i = bisect.bisect_right(self._starts, frame) - 1
        if i < 0:
            return None
        c = self.chunks[i]
        if not (c.start <= frame < c.end):
            return None
        active = max((k for k, w in enumerate(c.words) if w.start <= frame), default=-1)
        pop = min(POP_FRAMES, frame - c.start) if self.style.pop else POP_FRAMES
        return (c.index, active, pop)

    def describe(self, state: tuple) -> str:
        """Everything that decides a caption state's pixels (names its cached image)."""
        c = self.chunks[state[0]]
        return repr((self.style, self.center_y, self.box, [(w.text, w.emphasis) for w in c.words], state[1], state[2]))

    def band(self, frame_h: int) -> tuple[int, int]:
        """Rows [y0, y1) every caption state of this track draws into (the layer is cropped to it)."""
        if not self.style or self.box is None:
            return 0, 0
        f = font(self.style.family, self.style.size, max(self.style.weight, self.style.emphasis_weight))
        asc, desc = f.getmetrics() if hasattr(f, "getmetrics") else (self.style.size, self.style.size // 4)
        line_h = asc + desc
        pad_y = int(self.style.size * 0.18) if self.style.box else 0
        block_h = line_h + 2 * pad_y
        cy = min(self.center_y, self.box.bottom - block_h // 2 - 4)
        cy = max(cy, self.box.top + block_h // 2 + 4)
        half = block_h // 2 + 24 + 16 + self.style.stroke  # tile margin, shadow offset/blur, stroke
        y0, y1 = max(0, cy - half), min(frame_h, cy + half + 8)
        return y0 // 2 * 2, min(frame_h, (y1 + 1) // 2 * 2)


def build_track(
    cfg: Captions, words: list[Word], tm: TimeMap, box: Box, *, seam_y: int | None, frame_h: int
) -> CaptionTrack:
    if cfg.style == "none":
        return CaptionTrack(None)
    base = STYLES[cfg.style]
    from .graphics import hex_rgb

    if cfg.active_color:
        # A brand colour for the spoken word; styles without an active-word highlight gain one.
        base = replace(base, active=hex_rgb(cfg.active_color, base.active or base.emphasis))
    if cfg.emphasis_color:
        base = replace(base, emphasis=hex_rgb(cfg.emphasis_color, base.emphasis))
    style = CaptionStyle(
        base.family if not cfg.font else cfg.font,
        base.weight,
        round(base.size * (cfg.scale or 1.0)),
        cfg.max_words or base.max_words,
        base.max_chars if not cfg.max_words else max(base.max_chars, cfg.max_words * 6),
        cfg.case or base.case,
        base.stroke,
        base.shadow,
        base.box,
        base.text,
        base.active,
        base.emphasis,
        base.emphasis_weight,
        base.emphasis_italic,
        base.pop,
        base.dim_upcoming,
    )
    emph = {_core(t) for e in cfg.emphasis_words for t in e.split() if _core(t)}
    repl = {k.lower(): v for k, v in cfg.replace.items()}
    fps = tm.fps
    mapped: list[CapWord] = []
    last_kept = -2
    for wi, w in enumerate(words):
        span = tm.map_word(w.start, w.end)
        if span is None:
            continue
        if mapped and wi != last_kept + 1 and mapped[-1].text.endswith(","):
            # Words were cut between these two (a filler, a restart): a comma left behind would split the line.
            mapped[-1].text = mapped[-1].text[:-1]
        last_kept = wi
        text = w.text.strip()
        core = re.sub(r"^[^\w']+|[^\w']+$", "", text)
        if core.lower() in repl:
            text = text.replace(core, repl[core.lower()])
        a, b = round(span[0] * fps), round(span[1] * fps)
        if mapped and a < mapped[-1].end:
            a = max(a, mapped[-1].start + 1)
        mapped.append(CapWord(text, a, max(b, a + 1), _core(w.text) in emph))
    chunks: list[Chunk] = []
    cur: list[CapWord] = []
    gap_break = round(0.35 * fps)
    for w in mapped:
        if cur and (
            len(cur) >= style.max_words
            or sum(len(x.text) + 1 for x in cur) + len(w.text) > style.max_chars
            or w.start - cur[-1].end > gap_break
        ):
            chunks.append(Chunk(cur, cur[0].start, 0))
            cur = []
        cur.append(w)
        if re.search(r"[.,?!;:]['\")\]]*$", w.text):
            chunks.append(Chunk(cur, cur[0].start, 0))
            cur = []
    if cur:
        chunks.append(Chunk(cur, cur[0].start, 0))
    hold = round(0.3 * fps)
    for i, c in enumerate(chunks):
        c.index = i
        nxt = chunks[i + 1].start if i + 1 < len(chunks) else tm.output_frames
        c.end = (
            min(nxt, max(c.words[-1].end + hold, c.words[-1].end + 1))
            if nxt - c.words[-1].end > round(0.6 * fps)
            else nxt
        )
        c.end = max(c.end, c.start + 1)
    if cfg.position == "middle":
        cy = frame_h // 2
    elif cfg.position == "seam" and seam_y:
        cy = seam_y
    else:
        cy = round(frame_h * 0.65)
    return CaptionTrack(style, chunks, cy, box)


def composite(canvas: Image.Image, tile: Image.Image, x: int, y: int) -> None:
    """alpha_composite that tolerates a tile hanging off the canvas edge."""
    cx0, cy0 = max(0, -x), max(0, -y)
    cx1, cy1 = min(tile.width, canvas.width - x), min(tile.height, canvas.height - y)
    if cx1 <= cx0 or cy1 <= cy0:
        return
    if (cx0, cy0, cx1, cy1) != (0, 0, tile.width, tile.height):
        tile = tile.crop((cx0, cy0, cx1, cy1))
    canvas.alpha_composite(tile, (x + cx0, y + cy0))


def _case(text: str, case: str) -> str:
    return text.upper() if case == "upper" else text.lower() if case == "lower" else text


def draw_caption(
    canvas: Image.Image, track: CaptionTrack, state: tuple, origin_y: int = 0, frame_w: int | None = None
) -> tuple[int, int, int, int] | None:
    """Draws one caption state onto `canvas` (RGBA: the full frame, or a band of it starting at frame row
    `origin_y`). Returns the bounding box actually used, in frame coordinates."""
    st, box = track.style, track.box
    assert st is not None and box is not None
    chunk = track.chunks[state[0]]
    active, pop = state[1], state[2]
    texts = [_case(w.text, st.case) for w in chunk.words]
    size = st.size
    fw = frame_w or canvas.width
    max_w = 2 * min(fw // 2 - box.left, box.right - fw // 2) - 20

    def fonts_for(sz: int):
        return [
            font(
                st.family, sz, st.emphasis_weight if w.emphasis else st.weight, italic=st.emphasis_italic and w.emphasis
            )
            for w in chunk.words
        ]

    probe = ImageDraw.Draw(canvas)
    while True:
        fs = fonts_for(size)
        space = int(size * 0.28)
        widths = [probe.textbbox((0, 0), t, font=f, stroke_width=st.stroke)[2] for t, f in zip(texts, fs, strict=True)]
        total = sum(widths) + space * (len(texts) - 1)
        if total <= max_w or size <= 28:
            break
        size = max(28, int(size * max_w / total) - 1)
    asc, desc = fs[0].getmetrics() if hasattr(fs[0], "getmetrics") else (size, size // 4)
    line_h = asc + desc
    pad_x, pad_y = (int(size * 0.35), int(size * 0.18)) if st.box else (0, 0)
    block_h = line_h + 2 * pad_y
    cy = min(track.center_y, box.bottom - block_h // 2 - 4)
    cy = max(cy, box.top + block_h // 2 + 4)
    x0 = (canvas.width - total) // 2
    y0 = cy - line_h // 2
    m = 24  # tile margin for stroke, shadow and pop scaling
    tile = Image.new("RGBA", (total + 2 * pad_x + 2 * m, block_h + 2 * m), (0, 0, 0, 0))
    ox, oy = m + pad_x, m + pad_y  # text origin inside the tile
    d = ImageDraw.Draw(tile)
    if st.box:
        d.rounded_rectangle((m, m, m + total + 2 * pad_x, m + block_h), radius=int(size * 0.28), fill=st.box)
    if st.shadow:
        sh = Image.new("RGBA", tile.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        x = ox
        for t, f, wpx in zip(texts, fs, widths, strict=True):
            sd.text((x + 3, oy + 4), t, font=f, fill=(0, 0, 0, 170))
            x += wpx + space
        tile.alpha_composite(sh.filter(ImageFilter.GaussianBlur(5)))
        d = ImageDraw.Draw(tile)
    x = ox
    for i, (t, f, wpx, w) in enumerate(zip(texts, fs, widths, chunk.words, strict=True)):
        spoken = i <= active
        if st.active and i == active:
            color = st.active
        elif w.emphasis:
            color = st.emphasis
        else:
            color = st.text
        alpha = 255 if (spoken or not st.dim_upcoming) else 140
        d.text((x, oy), t, font=f, fill=(*color, alpha), stroke_width=st.stroke, stroke_fill=(0, 0, 0, alpha))
        x += wpx + space
    tx, ty = x0 - pad_x - m, y0 - pad_y - m
    if st.pop and pop < POP_FRAMES:
        p = (pop + 1) / (POP_FRAMES + 1)
        scale = 0.82 + 0.18 * (1 - (1 - p) ** 3)
        nw, nh = max(1, int(tile.width * scale)), max(1, int(tile.height * scale))
        tx, ty = tx + (tile.width - nw) // 2, ty + (tile.height - nh) // 2
        tile = tile.resize((nw, nh), Image.Resampling.BILINEAR)
    composite(canvas, tile, tx, ty - origin_y)
    bbox = (x0 - pad_x, y0 - pad_y, x0 + total + pad_x, y0 + line_h + pad_y)
    return (int(bbox[0]), int(bbox[1]), int(bbox[2] + (6 if st.shadow else 0)), int(bbox[3] + (8 if st.shadow else 0)))
