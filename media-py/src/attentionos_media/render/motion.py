"""Camera motion as one zoom value per output frame, so every source of motion composes and nothing fights:

- **Jump-cut alternation**: the framing alternates between 1.0 and 1 + `jumpCutZoom` at every cut (a shot shorter
  than 0.8 s keeps the previous level), so a jump cut reads as a deliberate camera change.
- **Hook push**: a slow eased push-in (+4%) across the first shot.
- **Punch-ins**: eased (smoothstep, 0.25 s) zooms of `punchScale` on emphasis words or sentence starts, at most one
  every `minGapS`, never within 0.6 s of a cut (the cut would undo it), held to the next cut or 2.5 s, then eased
  back out.
- **Plan camera moves** (`camera[]`): `zoom` eases in over 0.2 s and holds; `push` ramps over its duration. A
  plan move takes over from automatic motion while it runs (the larger zoom wins; they never multiply).

Auto motion only runs in `full` segments (the talking head); plan moves run in every mode except `split`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..schemas import CameraMove, Motion


@dataclass
class CapWordRef:
    start: int  # output frame
    end: int
    emphasis: bool
    sentence_start: bool


def _smooth(x: np.ndarray) -> np.ndarray:
    c = np.clip(x, 0.0, 1.0)
    return c * c * (3 - 2 * c)


def zoom_curve(
    n_frames: int,
    fps: int,
    joins: list[int],
    full_spans: list[tuple[int, int]],
    camera_spans: list[tuple[int, int]],
    words: list[CapWordRef],
    motion: Motion,
    camera: list[CameraMove],
) -> tuple[np.ndarray, list[int]]:
    """Returns (zoom per output frame, frames where a punch-in starts)."""
    z = np.ones(n_frames)
    if n_frames == 0:
        return z, []
    t = np.arange(n_frames)
    in_full = np.zeros(n_frames, bool)
    for a, b in full_spans:
        in_full[a:b] = True
    bounds = [0, *sorted(j for j in joins if 0 < j < n_frames), n_frames]
    # 1. jump-cut alternation
    if motion.jump_cut_zoom > 0:
        level = 0
        for k in range(len(bounds) - 1):
            a, b = bounds[k], bounds[k + 1]
            if k > 0 and (b - a) >= 0.8 * fps:
                level = 1 - level
            if level:
                z[a:b] *= 1 + motion.jump_cut_zoom * in_full[a:b]
    # 2. hook push across the first shot
    if motion.hook_push and len(bounds) > 1:
        a, b = bounds[0], bounds[1]
        ramp = min(b - a, round(3 * fps))
        if ramp > 2:
            prog = _smooth((t[a:b] - a) / ramp)
            z[a:b] *= 1 + 0.04 * prog * in_full[a:b]
    # 3. punch-ins
    punches: list[int] = []
    if motion.punch_ins != "off" and motion.punch_scale > 0:
        first_end = bounds[1] if motion.hook_push and len(bounds) > 1 else 0
        last = -(10**9)
        gap = round(motion.min_gap_s * fps)
        ease, hold, out_ = round(0.25 * fps), round(2.5 * fps), round(0.5 * fps)
        for w in words:
            if motion.punch_ins == "emphasis" and not w.emphasis:
                continue
            if motion.punch_ins == "sentences" and not w.sentence_start:
                continue
            s = max(0, w.start - round(0.08 * fps))
            if s < first_end or s - last < gap or not in_full[min(s, n_frames - 1)]:
                continue
            nxt = next((j for j in bounds[1:] if j > s), n_frames)
            if nxt - s < round(0.6 * fps):
                continue
            end_hold = min(nxt, s + ease + hold)
            seg = np.zeros(nxt - s)
            seg[: nxt - s] = _smooth((t[s:nxt] - s) / max(1, ease))
            if end_hold < nxt:  # ease back out before the next cut
                k0 = end_hold - s
                seg[k0:] *= 1 - _smooth((t[end_hold:nxt] - end_hold) / max(1, out_))
            z[s:nxt] *= 1 + motion.punch_scale * seg * in_full[s:nxt]
            punches.append(s)
            last = s
    # 4. plan camera moves: the move wins over automatic motion (never stacked on top of it)
    allowed = np.zeros(n_frames, bool)
    for a, b in camera_spans:
        allowed[a:b] = True
    for m in camera:
        a, b = round(m.at * fps), min(n_frames, round((m.at + m.dur) * fps))
        if b <= a or a >= n_frames:
            continue
        if m.kind == "zoom":
            prog = _smooth((t[a:b] - a) / max(1, min(round(0.2 * fps), (b - a) // 3 or 1)))
        else:
            prog = _smooth((t[a:b] - a) / max(1, b - a))
        planned = 1 + (m.scale - 1) * prog
        z[a:b] = np.where(allowed[a:b], np.maximum(z[a:b], planned), z[a:b])
    np.clip(z, 1.0, motion.max_zoom, out=z)
    return z, punches
