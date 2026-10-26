"""Burned-in titles and captions for trial reels, drawn with Pillow as transparent PNGs that ffmpeg only overlays
(so no ffmpeg build needs drawtext or libass). Sizes are for a 1080 px wide frame.

Caption styles: small white outlined captions, a boxed active word, a yellow active word, one big slanted word at a
time, condensed caps. Title styles: plain caps, a white box, a black box, small plain text.

Fonts are the OFL fonts AttentionOS already uses for captions (Montserrat and Geist, fetched by
`attentionos-media models download fonts`, see `fonts.py`). Condensed and slanted looks are made by scaling and
shearing the drawn text, so no extra font files are needed. Without the fonts (a fresh machine), Pillow's built-in
font is used and everything still renders and verifies. Emoji are left out: the image ships no colour emoji font.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..fonts import font as load_family

WHITE, BLACK, YELLOW = (255, 255, 255, 255), (0, 0, 0, 255), (255, 221, 51, 255)
EMOJI_RE = re.compile("[\U0001f000-\U0001faff☀-➿⬀-⯿️‍]")


@dataclass(frozen=True)
class FontSpec:
    family: str
    weight: int
    condense: float = 1.0  # horizontal scale of the drawn text (< 1 = condensed)
    slant: float = 0.0  # shear (0.18 ≈ an italic)


FONTS = {
    "sans_bold": FontSpec("montserrat", 700),
    "sans_heavy_slant": FontSpec("montserrat", 800, slant=0.18),
    "sans_black": FontSpec("montserrat", 900),
    "grotesk_bold": FontSpec("geist", 700),
    "condensed_semibold": FontSpec("geist", 600, condense=0.84),
    "condensed_medium": FontSpec("geist", 500, condense=0.84),
    "condensed_caps": FontSpec("geist", 700, condense=0.78),
}

CAPTION_STYLES = {
    "outline": {
        "font": "sans_bold",
        "size": 54,
        "max_words": 4,
        "max_chars": 24,
        "upper": False,
        "stroke": 5,
        "active": None,
    },
    "box_word": {
        "font": "sans_black",
        "size": 46,
        "max_words": 4,
        "max_chars": 22,
        "upper": False,
        "stroke": 4,
        "active": "box",
    },
    "yellow_word": {
        "font": "grotesk_bold",
        "size": 56,
        "max_words": 3,
        "max_chars": 20,
        "upper": False,
        "stroke": 5,
        "active": "yellow",
    },
    "single_caps": {
        "font": "sans_heavy_slant",
        "size": 84,
        "max_words": 1,
        "max_chars": 99,
        "upper": True,
        "stroke": 7,
        "active": None,
    },
    "caps_outline": {
        "font": "condensed_caps",
        "size": 74,
        "max_words": 3,
        "max_chars": 22,
        "upper": True,
        "stroke": 5,
        "active": None,
    },
}
TITLE_STYLES = {
    "plain_caps": {"font": "condensed_semibold", "size": 68, "upper": True, "stroke": 3, "fill": WHITE, "box": None},
    "white_box": {
        "font": "condensed_medium",
        "size": 70,
        "upper": False,
        "stroke": 0,
        "fill": (24, 24, 24, 255),
        "box": (250, 250, 250, 255),
    },
    "black_box": {"font": "condensed_medium", "size": 70, "upper": False, "stroke": 0, "fill": WHITE, "box": BLACK},
    "small_plain": {"font": "condensed_semibold", "size": 48, "upper": False, "stroke": 3, "fill": WHITE, "box": None},
}

CAPTION_STRIP_HEIGHT = 240
HOLD = 0.15  # a caption stays this long after its last word
BRIDGE = 0.35  # a pause shorter than this keeps the caption up until the next one
SENTENCE_GAP = 0.5


def strip_emoji(text: str) -> str:
    return re.sub(r"\s{2,}", " ", EMOJI_RE.sub("", text)).strip()


def load_font(key: str, size: float) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    spec = FONTS[key]
    return load_family(spec.family, max(8, round(size)), spec.weight)


def _size(font) -> float:
    return float(getattr(font, "size", 10))


def text_width(text: str, font) -> float:
    return float(font.getlength(text))


def _metrics(font) -> tuple[int, int]:
    try:
        return font.getmetrics()
    except AttributeError:  # bitmap fallback font
        return round(_size(font) * 0.8), round(_size(font) * 0.2)


def _shape(img: Image.Image, spec: FontSpec) -> Image.Image:
    """Condense and slant the drawn text (applied to the whole image so pixels stay exact for verify)."""
    out = img
    if spec.condense != 1.0:
        out = out.resize((max(1, round(out.width * spec.condense)), out.height), Image.Resampling.LANCZOS)
    if spec.slant:
        # x_src = x + slant * (y - h/2): the top leans right, the baseline stays centred.
        h = out.height
        out = out.transform(
            out.size, Image.Transform.AFFINE, (1, spec.slant, -spec.slant * h / 2, 0, 1, 0), Image.Resampling.BICUBIC
        )
    return out


def _wrap(text: str, font, max_width: float) -> list[str]:
    lines: list[str] = []
    for word in text.split():
        candidate = f"{lines[-1]} {word}" if lines else word
        fits = bool(lines) and text_width(candidate, font) <= max_width
        lines = [*lines[:-1], candidate] if fits else [*lines, word]
    return lines or [""]


def title_image(text: str, style_name: str, frame_width: int, max_width: float = 0.86) -> Image.Image:
    """A tight transparent image of the title (one or more centred lines, optional rounded box)."""
    style = TITLE_STYLES[style_name]
    spec = FONTS[style["font"]]
    scale = frame_width / 1080
    font = load_font(style["font"], style["size"] * scale)
    text = strip_emoji(text)
    # Wrap against the width the text will have after condensing.
    lines = _wrap(text.upper() if style["upper"] else text, font, frame_width * max_width / spec.condense)
    ascent, descent = _metrics(font)
    line_height = ascent + descent
    pad_x, pad_y = (round(36 * scale / spec.condense), round(20 * scale)) if style["box"] else (round(8 * scale),) * 2
    width = round(max(text_width(line, font) for line in lines)) + 2 * pad_x
    height = line_height * len(lines) + 2 * pad_y
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if style["box"]:
        draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=round(26 * scale), fill=style["box"])
    stroke = round(style["stroke"] * scale)
    for i, line in enumerate(lines):
        x = (width - text_width(line, font)) / 2
        draw.text(
            (x, pad_y + i * line_height), line, font=font, fill=style["fill"], stroke_width=stroke, stroke_fill=BLACK
        )
    return _shape(img, spec)


def _display(word: str, style: dict) -> str:
    return word.upper() if style["upper"] else word


def chunks(words: list[dict], style: dict) -> list[list[dict]]:
    """Group words into caption lines: a few words, never across a sentence end or a pause."""
    out: list[list[dict]] = []
    current: list[dict] = []
    for word in words:
        joined = " ".join(w["w"] for w in [*current, word])
        if current and (
            len(current) >= style["max_words"]
            or len(joined) > style["max_chars"]
            or word["s"] - current[-1]["e"] > SENTENCE_GAP
            or current[-1]["w"][-1] in ".?!"
        ):
            out.append(current)
            current = []
        current = [*current, word]
    return [*out, current] if current else out


def caption_states(words: list[dict], style_name: str, duration: float) -> list[tuple]:
    """Every caption image and when it shows: (start, end, tokens, index of the active word)."""
    style = CAPTION_STYLES[style_name]
    lines = chunks(words, style)
    states: list[tuple] = []
    for k, line in enumerate(lines):
        next_start = lines[k + 1][0]["s"] if k + 1 < len(lines) else duration
        end = next_start if next_start - line[-1]["e"] < BRIDGE else min(line[-1]["e"] + HOLD, next_start)
        tokens = tuple(_display(w["w"], style) for w in line)
        if style["active"]:
            starts = [line[0]["s"], *(w["s"] for w in line[1:]), end]
            states.extend((starts[j], starts[j + 1], tokens, j) for j in range(len(line)))
        else:
            states.append((line[0]["s"], end, tokens, None))
    return [s for s in states if s[1] - s[0] > 0.02]


def caption_image(tokens: tuple, active: int | None, style_name: str, frame_width: int) -> Image.Image:
    """One caption line, centred in a full-width transparent strip."""
    style = CAPTION_STYLES[style_name]
    spec = FONTS[style["font"]]
    scale = frame_width / 1080
    # Draw on a canvas that is 1/condense wider, then squeeze it back to the frame width.
    canvas_w = round(frame_width / spec.condense)
    strip = Image.new("RGBA", (canvas_w, round(CAPTION_STRIP_HEIGHT * scale)), (0, 0, 0, 0))
    font = load_font(style["font"], style["size"] * scale)
    full = text_width(" ".join(tokens), font)
    limit = canvas_w * (0.84 if spec.slant else 0.9)
    if full > limit:
        font = load_font(style["font"], _size(font) * limit / full)
    space = text_width(" ", font)
    ascent, descent = _metrics(font)
    x = (canvas_w - text_width(" ".join(tokens), font)) / 2
    y = (strip.height - (ascent + descent)) / 2
    stroke = round(style["stroke"] * scale)
    draw = ImageDraw.Draw(strip)
    for i, token in enumerate(tokens):
        width = text_width(token, font)
        is_active = i == active
        if is_active and style["active"] == "box":
            pad = round(10 * scale)
            draw.rounded_rectangle(
                (x - pad, y - pad / 2, x + width + pad, y + ascent + descent + pad / 2),
                radius=round(12 * scale),
                fill=BLACK,
            )
            draw.text((x, y), token, font=font, fill=WHITE)
        else:
            fill = YELLOW if is_active and style["active"] == "yellow" else WHITE
            draw.text((x, y), token, font=font, fill=fill, stroke_width=stroke, stroke_fill=BLACK)
        x += width + space
    shaped = _shape(strip, spec)
    if shaped.width != frame_width:  # rounding from the condense step
        shaped = shaped.resize((frame_width, shaped.height), Image.Resampling.LANCZOS)
    return shaped


def write_captions(words: list[dict], style_name: str, duration: float, frame_width: int, out_dir: Path) -> Path:
    """Draw every caption state into out_dir and write the ffconcat timeline that ffmpeg overlays."""
    out_dir.mkdir(parents=True, exist_ok=True)
    blank = Image.new("RGBA", (frame_width, round(CAPTION_STRIP_HEIGHT * frame_width / 1080)), (0, 0, 0, 0))
    blank.save(out_dir / "blank.png", compress_level=1)
    names: dict[tuple, str] = {}
    entries: list[tuple[str, float]] = []
    clock = 0.0
    for start, end, tokens, active in caption_states(words, style_name, duration):
        if end <= clock:
            continue
        if start - clock > 0.02:
            entries.append(("blank.png", round(start, 3) - round(clock, 3)))
            clock = start
        key = (tokens, active)
        if key not in names:
            names[key] = f"c{len(names):04d}.png"
            caption_image(tokens, active, style_name, frame_width).save(out_dir / names[key], compress_level=1)
        entries.append((names[key], round(end, 3) - round(clock, 3)))
        clock = end
    if duration - clock > 0.02:
        entries.append(("blank.png", round(duration, 3) - round(clock, 3)))
    lines = ["ffconcat version 1.0"]
    for name, seconds in entries:
        lines += [f"file '{name}'", f"duration {seconds:.3f}"]
    lines.append("file 'blank.png'")  # the concat demuxer only honours a duration when a file follows it
    timeline = out_dir / "captions.ffconcat"
    timeline.write_text("\n".join(lines) + "\n")
    return timeline
