"""Source → output time map (mirror of `packages/media/src/time-map.ts`; both must agree frame for frame).

Keep ranges are given in SOURCE seconds and quantised to frames with `frame(t) = floor(t * fps + 0.5)`
(JavaScript's Math.round), so the TypeScript side and this module produce identical frame numbers.
Everything downstream (captions, overlays, SFX, camera) is keyed to OUTPUT frames.

The bug class this guards against: comparing output-mapped times with source-time pauses. Pauses and silences
are source-time facts; map them with `source_range_to_output` before comparing with anything in output time.
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Iterable
from dataclasses import dataclass


def to_frame(t: float, fps: int) -> int:
    return math.floor(t * fps + 0.5)


@dataclass(frozen=True)
class Keep:
    src_start: int  # frame, inclusive
    src_end: int  # frame, exclusive
    out_start: int

    @property
    def length(self) -> int:
        return self.src_end - self.src_start


class TimeMap:
    def __init__(self, fps: int, source_frames: int, keeps: list[Keep]):
        self.fps = fps
        self.source_frames = source_frames
        self.keeps = keeps
        self.output_frames = sum(k.length for k in keeps)
        self._src_starts = [k.src_start for k in keeps]
        self._out_starts = [k.out_start for k in keeps]

    # -- construction ---------------------------------------------------------------------------------
    @classmethod
    def from_keep_ranges(cls, ranges: Iterable[tuple[float, float]], fps: int, source_duration_s: float) -> TimeMap:
        source_frames = to_frame(source_duration_s, fps)
        frames = sorted((max(0, to_frame(a, fps)), min(source_frames, to_frame(b, fps))) for a, b in ranges)
        merged: list[list[int]] = []
        for a, b in frames:
            if b <= a:
                continue
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        keeps: list[Keep] = []
        out = 0
        for a, b in merged:
            keeps.append(Keep(a, b, out))
            out += b - a
        return cls(fps, source_frames, keeps)

    @classmethod
    def identity(cls, fps: int, source_duration_s: float) -> TimeMap:
        return cls.from_keep_ranges([(0.0, source_duration_s)], fps, source_duration_s)

    # -- frames ---------------------------------------------------------------------------------------
    def src_to_out(self, frame: int) -> int | None:
        """Output frame for a kept source frame, None if the frame was cut."""
        i = bisect.bisect_right(self._src_starts, frame) - 1
        if i < 0:
            return None
        k = self.keeps[i]
        if frame < k.src_end:
            return k.out_start + frame - k.src_start
        return None

    def src_to_out_snap(self, frame: int) -> int:
        """Like src_to_out, but a cut frame snaps to the output frame where playback resumes."""
        for k in self.keeps:
            if frame < k.src_start:
                return k.out_start
            if frame < k.src_end:
                return k.out_start + frame - k.src_start
        return self.output_frames

    def out_to_src(self, frame: int) -> int:
        if frame >= self.output_frames:
            return self.keeps[-1].src_end if self.keeps else 0
        i = bisect.bisect_right(self._out_starts, frame) - 1
        k = self.keeps[max(0, i)]
        return k.src_start + frame - k.out_start

    def source_range_to_output(self, a: int, b: int) -> list[tuple[int, int]]:
        """Output frame ranges covering the kept part of source frames [a, b)."""
        out: list[tuple[int, int]] = []
        for k in self.keeps:
            lo, hi = max(a, k.src_start), min(b, k.src_end)
            if hi > lo:
                out.append((k.out_start + lo - k.src_start, k.out_start + hi - k.src_start))
        return out

    def output_range_to_source(self, a: int, b: int) -> list[tuple[int, int]]:
        """Source frame pieces that play during output frames [a, b), in playback order."""
        pieces: list[tuple[int, int]] = []
        for k in self.keeps:
            lo, hi = max(a, k.out_start), min(b, k.out_start + k.length)
            if hi > lo:
                pieces.append((k.src_start + lo - k.out_start, k.src_start + hi - k.out_start))
        return pieces

    # -- seconds --------------------------------------------------------------------------------------
    @property
    def output_duration_s(self) -> float:
        return self.output_frames / self.fps

    def map_word(self, start_s: float, end_s: float) -> tuple[float, float] | None:
        """Output seconds of a source-time word, or None when the word was cut entirely."""
        a, b = to_frame(start_s, self.fps), max(to_frame(end_s, self.fps), to_frame(start_s, self.fps) + 1)
        spans = self.source_range_to_output(a, b)
        if not spans:
            return None
        return spans[0][0] / self.fps, spans[-1][1] / self.fps

    def keep_ranges_s(self) -> list[tuple[float, float]]:
        return [(k.src_start / self.fps, k.src_end / self.fps) for k in self.keeps]

    def joins_output_frames(self) -> list[int]:
        """Output frames where one keep range ends and the next begins (the cuts the viewer sees)."""
        return [k.out_start for k in self.keeps[1:]]
