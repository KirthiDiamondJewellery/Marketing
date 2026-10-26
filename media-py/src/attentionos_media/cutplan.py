"""`cut-plan`: turn a talking-head recording into a reviewable edit map (`edit.json`).

Method, all in SOURCE time:
1. Spoken edit notes ("cut that", "editor, cut", configurable) remove the flubbed take and the note itself.
2. "Last full take wins": when a line is said again (fuzzy match on the transcript), earlier takes are dropped,
   unless the later take looks broken off (then both stay and the reviewer is told).
3. The hook zone (the first seconds of the first kept line) is protected from silence cuts.
4. Dual-threshold silence: a pause is cut only where the strict detector (≈ −42 dB on a 10 ms envelope) and the
   broad detector (≈ −35 dB on a smoothed 50 ms envelope) agree. Thresholds are loudness-derived (applied as if
   the clip were at −14 LUFS) and clamped above the room floor.
5. Word protection: nothing within `wordPadS` of any word is ever removed; a pause with a word heard inside it is
   kept. Word tails are extended to where the audio really stops.
6. Lead-in before the first word and the dead tail after the last word are trimmed; slivers shorter than
   `minKeepS` with no word in them are dropped; cuts shorter than `minCutS` are skipped.
7. Restarts and stutters inside a sentence ("we tested, we tested this") keep the last attempt.
8. Filler words: "um", "uh" and friends always go; guarded fillers ("like", "you know", "I mean") only when the
   transcript sets them off with commas, pauses or a sentence edge. Sound between two pauses with no word in it
   (an "um" the ASR left out, a breath, a lip smack) is cut when it is short; longer unheard sound is flagged.
9. Zero dead space: pauses are cut to a tight join, but a sentence end keeps a natural micro-pause
   (`sentencePauseS`, under the `maxPauseS` limit) so the delivery still breathes.
10. Everything is quantised to frames. Every cut and every pause that was considered but kept carries a reason.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
from pydantic import Field

from .audio import HOP_S, SR, SilenceOptions, measure_gaps, measure_loudness, silence_map
from .errors import BadInput, NotFound
from .ffmpeg import decode_audio, log
from .schemas import Range, ReasonRange, Transcript, Wire, Word
from .timemap import TimeMap, to_frame

DEFAULT_EDIT_NOTE_PHRASES = [
    "editor cut that",
    "editor cut",
    "cut that",
    "scratch that",
    "let me redo that",
    "let me do that again",
    "take that out",
    "start over",
]


# Always fillers when they stand alone as a word.
DEFAULT_FILLER_WORDS = ["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm", "mhm"]
# Fillers only when set off by commas, pauses or a sentence edge ("it was, like, huge" but not "I like it").
DEFAULT_GUARDED_FILLERS = ["like", "you know", "i mean"]
# Doubled words that are usually on purpose ("very very", "that that").
INTENTIONAL_DOUBLES = {
    "very",
    "really",
    "so",
    "no",
    "yes",
    "yeah",
    "that",
    "had",
    "bye",
    "ha",
    "go",
    "more",
    "many",
    "far",
    "long",
    "again",
    "is",
}


class CutPlanOptions(Wire):
    fps: int = Field(default=30, ge=1, le=120)
    strict_db: float = -42.0
    broad_db: float = -35.0
    strict_min_s: float = Field(default=0.12, gt=0)
    broad_min_s: float = Field(default=0.12, gt=0)
    target_lufs: float | None = -14.0
    floor_margin_db: float = 3.0
    word_pad_s: float = Field(default=0.05, ge=0)
    audio_pad_s: float = Field(default=0.03, ge=0)
    tail_pad_s: float = Field(default=0.08, ge=0)
    hook_protect_s: float = Field(default=0.6, ge=0)
    protect: list[ReasonRange] = Field(default_factory=list)
    min_keep_s: float = Field(default=0.2, ge=0)
    min_cut_s: float = Field(default=0.05, ge=0)
    retakes: bool = True
    retake_similarity: float = Field(default=0.72, gt=0, le=1)
    retake_window_s: float = Field(default=45.0, gt=0)
    edit_notes: bool = True
    edit_note_phrases: list[str] = Field(default_factory=lambda: list(DEFAULT_EDIT_NOTE_PHRASES))
    phrase_gap_s: float = Field(default=0.6, gt=0)
    max_pause_s: float = Field(default=0.15, gt=0)
    restarts: bool = True
    fillers: bool = True
    filler_words: list[str] = Field(default_factory=lambda: list(DEFAULT_FILLER_WORDS))
    guarded_fillers: list[str] = Field(default_factory=lambda: list(DEFAULT_GUARDED_FILLERS))
    filler_islands: bool = True
    island_max_s: float = Field(default=0.7, gt=0, le=3)
    sentence_pause_s: float = Field(default=0.10, ge=0, le=1)


class CutPlanInput(Wire):
    audio_path: str
    transcript: Transcript
    source_path: str | None = None
    duration_s: float | None = None
    options: CutPlanOptions = Field(default_factory=CutPlanOptions)


@dataclass
class Drop:
    start: float
    end: float
    kind: str  # silence | lead_in | tail | retake | edit_note | sliver
    reason: str
    words: list[str] | None = None
    evidence: dict | None = None


def _norm(token: str) -> str:
    return re.sub(r"[^\w']+", "", token.lower())


@dataclass
class Phrase:
    i0: int
    i1: int  # inclusive

    def tokens(self, toks: list[str]) -> list[str]:
        return [t for t in toks[self.i0 : self.i1 + 1] if t]


def split_phrases(words: list[Word], gap_s: float) -> list[Phrase]:
    phrases: list[Phrase] = []
    start = 0
    for i, w in enumerate(words):
        last = i == len(words) - 1
        ends_sentence = bool(re.search(r"[.?!]['\")\]]*$", w.text.strip()))
        gap = (words[i + 1].start - w.end) if not last else 0.0
        if last or ends_sentence or gap >= gap_s:
            phrases.append(Phrase(start, i))
            start = i + 1
    return phrases


class Planner:
    def __init__(self, inp: CutPlanInput):
        self.o = inp.options
        self.words = sorted((w for w in inp.transcript.words if w.text.strip()), key=lambda w: w.start)
        self.toks = [_norm(w.text) for w in self.words]
        self.audio_path = inp.audio_path
        self.source_path = inp.source_path or inp.audio_path
        self.duration = inp.duration_s
        self.drops: list[Drop] = []
        self.kept: list[dict] = []
        self.flags: list[dict] = []
        self.protected: list[ReasonRange] = list(self.o.protect)
        self.dropped_words: set[int] = set()

    # -- audio ----------------------------------------------------------------------------------------------
    def load_audio(self) -> None:
        if not Path(self.audio_path).exists():
            raise NotFound("Audio file", self.audio_path)
        self.x = decode_audio(self.audio_path, SR)
        if self.duration is None:
            self.duration = len(self.x) / SR
        loud = measure_loudness(self.audio_path) if self.o.target_lufs is not None else None
        so = SilenceOptions(
            self.o.strict_db,
            self.o.broad_db,
            self.o.strict_min_s,
            self.o.broad_min_s,
            0.05,
            self.o.target_lufs,
            self.o.floor_margin_db,
        )
        self.smap, self.db = silence_map(self.x, SR, loud, so)

    def _frame_db(self, t: float) -> float:
        i = int(t / HOP_S)
        if i < 0 or i >= len(self.db):
            return -120.0
        return float(self.db[i])

    def speech_end(self, t: float, max_s: float = 0.25) -> float:
        """Where the voice really stops after an ASR word end (ASR often ends words early)."""
        thr = self.smap.strict_db
        e = t
        while e < t + max_s and self._frame_db(e) >= thr:
            e += HOP_S
        return e

    def speech_start(self, t: float, max_s: float = 0.08) -> float:
        """Walk back over a soft onset ("s", "f", a "p" burst) the ASR may have missed."""
        thr = self.smap.strict_db
        s = t
        while s > t - max_s and s > 0 and self._frame_db(s - HOP_S) >= thr:
            s -= HOP_S
        return max(0.0, s)

    # -- content drops ----------------------------------------------------------------------------------------
    def _span_range(self, i0: int, i1: int) -> tuple[float, float]:
        """Source range that removes words i0..i1 and the quiet around them, leaving the neighbours' pads."""
        pad = self.o.word_pad_s
        prev = i0 - 1
        while prev >= 0 and prev in self.dropped_words:
            prev -= 1
        nxt = i1 + 1
        while nxt < len(self.words) and nxt in self.dropped_words:
            nxt += 1
        a = self.speech_end(self.words[prev].end) + pad if prev >= 0 else max(0.0, self.words[i0].start - pad)
        b = self.speech_start(self.words[nxt].start) - pad if nxt < len(self.words) else self.words[i1].end + pad
        a = min(a, self.words[i0].start)
        b = max(b, self.words[i1].end)
        return a, b

    def edit_notes(self, phrases: list[Phrase]) -> None:
        if not self.o.edit_notes or not self.words:
            return
        patterns = sorted(
            {tuple(_norm(t) for t in p.split() if _norm(t)) for p in self.o.edit_note_phrases}, key=len, reverse=True
        )
        i = 0
        while i < len(self.toks):
            hit = next((p for p in patterns if p and tuple(self.toks[i : i + len(p)]) == p), None)
            if not hit:
                i += 1
                continue
            k, m = i, i + len(hit) - 1
            pi = next(n for n, ph in enumerate(phrases) if ph.i0 <= k <= ph.i1)
            ph = phrases[pi]
            if ph.i0 < k:
                d0 = ph.i0  # the flub is the start of this phrase, the note follows it
            elif pi > 0:
                d0 = phrases[pi - 1].i0  # the note opens a phrase: the previous phrase was the flub
            else:
                d0 = k
            note_text = " ".join(w.text.strip() for w in self.words[k : m + 1])
            flub = " ".join(w.text.strip() for w in self.words[d0:k])
            a, b = self._span_range(d0, m)
            reason = f"Spoken edit note “{note_text}”" + (
                f" removes the take before it (“{_clip(flub)}”)." if flub else "."
            )
            self.drops.append(Drop(a, b, "edit_note", reason, [w.text.strip() for w in self.words[d0 : m + 1]]))
            self.dropped_words.update(range(d0, m + 1))
            i = m + 1

    def retakes(self, phrases: list[Phrase]) -> None:
        if not self.o.retakes:
            return
        for a_idx, pa in enumerate(phrases):
            if any(n in self.dropped_words for n in range(pa.i0, pa.i1 + 1)):
                continue
            ta = pa.tokens(self.toks)
            if len(ta) < 2:
                continue
            for pb in phrases[a_idx + 1 :]:
                if self.words[pb.i0].start - self.words[pa.i1].end > self.o.retake_window_s:
                    break
                if any(n in self.dropped_words for n in range(pb.i0, pb.i1 + 1)):
                    continue
                tb = pb.tokens(self.toks)
                if len(tb) < 2:
                    continue
                score = _take_similarity(ta, tb)
                if score < self.o.retake_similarity:
                    continue
                later_at = self.words[pb.i0].start
                text_a = _clip(" ".join(w.text.strip() for w in self.words[pa.i0 : pa.i1 + 1]))
                if len(tb) >= 0.8 * len(ta) or _ends_sentence(self.words[pb.i1].text):
                    a, b = self._span_range(pa.i0, pa.i1)
                    self.drops.append(
                        Drop(
                            a,
                            b,
                            "retake",
                            f"Earlier take of “{text_a}”; a later full take starts at {later_at:.2f}s (last full take wins).",
                            [w.text.strip() for w in self.words[pa.i0 : pa.i1 + 1]],
                            {"similarity": round(score, 3), "laterTakeAt": round(later_at, 3)},
                        )
                    )
                    self.dropped_words.update(range(pa.i0, pa.i1 + 1))
                else:
                    self.flags.append(
                        {
                            "at": round(self.words[pa.i0].start, 3),
                            "message": f"“{text_a}” is said again at {later_at:.2f}s, but the later take looks broken off. Both kept; pick one.",
                        }
                    )
                break

    def restarts(self) -> None:
        """A sequence said, abandoned and said again inside a sentence keeps the last attempt: "we tested, we tested
        this" → "we tested this"; "the the" → "the". The abandoned part must not finish a sentence, and (unless the
        repeat is immediate) the speaker pauses before restarting."""
        if not self.o.restarts:
            return
        idx = [i for i in range(len(self.words)) if i not in self.dropped_words and self.toks[i]]
        toks = [self.toks[i] for i in idx]
        k = 0
        while k < len(idx):
            hit = None
            for n in (6, 5, 4, 3, 2, 1):
                if k + 2 * n > len(idx):
                    continue
                seq = toks[k : k + n]
                for extra in range(0, 9 if n >= 2 else 1):
                    j = k + n + extra
                    if j + n > len(idx) or toks[j : j + n] != seq:
                        continue
                    between = idx[k:j]
                    if any(_ends_sentence(self.words[i].text) for i in between[:-1]):
                        break
                    if extra and _ends_sentence(self.words[idx[j - 1]].text):
                        break
                    gap = self.words[idx[j]].start - self.words[idx[j - 1]].end
                    if n == 1 and (seq[0] in INTENTIONAL_DOUBLES or extra):
                        break
                    if extra and gap < 0.15 and not _soft_break(self.words[idx[j - 1]].text):
                        break
                    hit = (k, j, n)
                    break
                if hit:
                    break
            if not hit:
                k += 1
                continue
            k0, j, n = hit
            d0, d1 = idx[k0], idx[j - 1]
            a, b = self._span_range(d0, d1)
            said = " ".join(self.words[i].text.strip() for i in idx[k0:j])
            kind = "stutter" if n == 1 and j == k0 + 1 else "restart"
            self.drops.append(
                Drop(
                    a,
                    b,
                    "retake",
                    f"Restart: “{_clip(said)}” is said again right after; the last attempt is kept."
                    if kind == "restart"
                    else f"Doubled word “{said}”.",
                    [self.words[i].text.strip() for i in idx[k0:j]],
                    {"pattern": kind, "repeatAt": round(self.words[idx[j]].start, 3)},
                )
            )
            self.dropped_words.update(idx[k0:j])
            k = j

    def fillers(self) -> None:
        """Filler words from the transcript. Guarded fillers need a boundary on both sides: a comma or other
        punctuation, a pause of 0.15 s or more, or the start or end of a sentence."""
        if not self.o.fillers or not self.words:
            return
        always = {_norm(w) for w in self.o.filler_words if _norm(w)}
        guarded = sorted(
            {tuple(_norm(t) for t in g.split() if _norm(t)) for g in self.o.guarded_fillers}, key=len, reverse=True
        )
        i = 0
        while i < len(self.words):
            if i in self.dropped_words or not self.toks[i]:
                i += 1
                continue
            span = None
            if self.toks[i] in always:
                span = (i, i)
            else:
                for g in guarded:
                    if (
                        g
                        and tuple(self.toks[i : i + len(g)]) == g
                        and not any(n in self.dropped_words for n in range(i, i + len(g)))
                    ):
                        if self._set_off(i, i + len(g) - 1):
                            span = (i, i + len(g) - 1)
                        break
            if span is None:
                i += 1
                continue
            a, b = self._span_range(*span)
            said = " ".join(w.text.strip() for w in self.words[span[0] : span[1] + 1])
            self.drops.append(
                Drop(
                    a,
                    b,
                    "filler",
                    f"Filler “{said.strip(',.?!')}”.",
                    [w.text.strip() for w in self.words[span[0] : span[1] + 1]],
                )
            )
            self.dropped_words.update(range(span[0], span[1] + 1))
            i = span[1] + 1

    def _set_off(self, i0: int, i1: int) -> bool:
        prev = next((k for k in range(i0 - 1, -1, -1) if k not in self.dropped_words), None)
        nxt = next((k for k in range(i1 + 1, len(self.words)) if k not in self.dropped_words), None)
        before = (
            prev is None
            or _soft_break(self.words[prev].text)
            or _ends_sentence(self.words[prev].text)
            or self.words[i0].start - self.words[prev].end >= 0.15
        )
        after = (
            nxt is None
            or _soft_break(self.words[i1].text)
            or _ends_sentence(self.words[i1].text)
            or self.words[nxt].start - self.words[i1].end >= 0.15
        )
        return before and after

    # -- silence ------------------------------------------------------------------------------------------------
    def hook_zone(self) -> None:
        first = next((i for i in range(len(self.words)) if i not in self.dropped_words), None)
        if first is None or self.o.hook_protect_s <= 0:
            return
        s = self.words[first].start
        self.protected.append(
            ReasonRange(
                start=max(0.0, s - self.o.word_pad_s), end=s + self.o.hook_protect_s, reason="hook zone", kind="hook"
            )
        )

    def silences(self) -> None:
        pad, apad = self.o.word_pad_s, self.o.audio_pad_s
        kept_words = [w for i, w in enumerate(self.words) if i not in self.dropped_words]
        for s, e in self.smap.strict:
            rec = {"start": s, "end": e}
            broad = next(((bs, be) for bs, be in self.smap.broad if bs < e and be > s), None)
            if broad is None:
                self.kept.append(
                    {
                        **rec,
                        "reason": f"Not confirmed by the second detector ({self.smap.broad_db:.0f} dB): likely a soft sound, not a pause.",
                    }
                )
                continue
            a, b = max(s, broad[0]) + apad, min(e, broad[1]) - apad
            inside = [w for w in kept_words if w.start >= s and w.end <= e]
            if inside:
                self.kept.append({**rec, "reason": f"A word was heard inside this pause (“{inside[0].text.strip()}”)."})
                continue
            for w in kept_words:
                if w.end + pad > a and w.start - pad < b:
                    if w.start < a:  # word before the pause, overlapping its start
                        a = max(a, self.speech_end(w.end) + pad)
                    else:
                        b = min(b, self.speech_start(w.start) - pad)
            pieces = _subtract([(a, b)], [(p.start, p.end) for p in self.protected])
            if not pieces:
                why = next((p.reason for p in self.protected if p.start < b and p.end > a), "protected")
                self.kept.append({**rec, "reason": f"Inside a protected range ({why})."})
                continue
            prev_word = next((w for w in reversed(kept_words) if w.end <= s + 0.05), None)
            for pa, pb in pieces:
                if prev_word is not None and _ends_sentence(prev_word.text) and self.o.sentence_pause_s > 0:
                    # Keep a natural breath after a full stop: the quiet left on both sides of the join adds
                    # up to sentencePauseS (still under the maxPauseS limit QC enforces).
                    left = (pa - s) + (e - pb)
                    target = min(self.o.sentence_pause_s, self.o.max_pause_s - 0.02)
                    if left < target:
                        pa = min(pa + (target - left), pb)
                if pb - pa < self.o.min_cut_s:
                    self.kept.append({**rec, "reason": "Too short to matter after word padding."})
                    continue
                self.drops.append(
                    Drop(
                        pa,
                        pb,
                        "silence",
                        f"Pause of {e - s:.2f}s (both detectors agree).",
                        None,
                        {"strict": [s, e], "broad": list(broad)},
                    )
                )

    def edges(self) -> None:
        assert self.duration is not None
        kept_idx = [i for i in range(len(self.words)) if i not in self.dropped_words]
        if not kept_idx:
            return
        first, last = self.words[kept_idx[0]], self.words[kept_idx[-1]]
        lead_end = self.speech_start(first.start) - self.o.word_pad_s
        if lead_end > self.o.min_cut_s:
            self.drops.append(Drop(0.0, lead_end, "lead_in", f"Lead-in before the first word ({lead_end:.2f}s)."))
        tail_start = self.speech_end(last.end) + self.o.tail_pad_s
        if self.duration - tail_start > self.o.min_cut_s:
            self.drops.append(
                Drop(
                    tail_start,
                    self.duration,
                    "tail",
                    f"Dead tail after the last word ({self.duration - tail_start:.2f}s).",
                )
            )

    # -- assemble -------------------------------------------------------------------------------------------------
    def assemble(self) -> dict:
        assert self.duration is not None
        fps = self.o.fps
        src_frames = to_frame(self.duration, fps)
        # Quantise every drop to frames, then merge.
        framed = sorted(
            ((max(0, to_frame(d.start, fps)), min(src_frames, to_frame(d.end, fps)), d) for d in self.drops),
            key=lambda x: x[0],
        )
        merged: list[list] = []
        for a, b, d in framed:
            if b <= a:
                continue
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
                merged[-1][2].append(d)
            else:
                merged.append([a, b, [d]])
        # Keep pieces between drops; drop slivers with no word in them.
        word_frames = [
            (to_frame(w.start, fps), to_frame(w.end, fps))
            for i, w in enumerate(self.words)
            if i not in self.dropped_words
        ]
        keeps: list[tuple[int, int]] = []
        cursor = 0
        for a, b, _ in merged:
            if a > cursor:
                keeps.append((cursor, a))
            cursor = max(cursor, b)
        if cursor < src_frames:
            keeps.append((cursor, src_frames))
        min_keep = to_frame(self.o.min_keep_s, fps)
        final_keeps: list[tuple[int, int]] = []
        slivers: list[tuple[int, int]] = []
        island_max = to_frame(self.o.island_max_s, fps)
        islands: list[tuple[int, int]] = []
        for n_k, (a, b) in enumerate(keeps):
            has_word = any(ws < b and we > a for ws, we in word_frames)
            inner = 0 < n_k < len(keeps) - 1 or (a > 0 and b < src_frames)
            if b - a < min_keep and not has_word:
                slivers.append((a, b))
            elif not has_word and self.o.filler_islands and inner and b - a <= island_max and self._voiced(a, b):
                islands.append((a, b))
            else:
                if not has_word and b - a > island_max and self._voiced(a, b):
                    self.flags.append(
                        {
                            "at": round(a / fps, 3),
                            "message": f"Sound with no words in the transcript at {a / fps:.2f}s ({(b - a) / fps:.1f}s). Kept; check it isn't a missed line.",
                        }
                    )
                final_keeps.append((a, b))
        cuts = []
        for a, b, ds in merged:
            primary = ds[0]
            words = [w for d in ds for w in (d.words or [])]
            entry = {
                "start": a / fps,
                "end": b / fps,
                "kind": primary.kind,
                "reason": " ".join(dict.fromkeys(d.reason for d in ds)),
            }
            if words:
                entry["words"] = words
            if primary.evidence:
                entry["evidence"] = primary.evidence
            cuts.append(entry)
        for a, b in islands:
            cuts.append(
                {
                    "start": a / fps,
                    "end": b / fps,
                    "kind": "filler",
                    "reason": "Sound between two pauses with no word in it (an “um”, a breath or a lip smack).",
                }
            )
        for a, b in slivers:
            cuts.append(
                {
                    "start": a / fps,
                    "end": b / fps,
                    "kind": "sliver",
                    "reason": "A sliver of sound between cuts with no word in it (a click or breath).",
                }
            )
        cuts.sort(key=lambda c: c["start"])
        tm = TimeMap.from_keep_ranges([(a / fps, b / fps) for a, b in final_keeps], fps, self.duration)
        estimate = self.estimate(tm)
        removed = self.duration - tm.output_duration_s
        return {
            "version": 1,
            "status": "review",
            "fps": fps,
            "source": {"path": self.source_path, "durationS": round(self.duration, 4)},
            "keepRanges": [{"start": round(a, 6), "end": round(b, 6)} for a, b in tm.keep_ranges_s()],
            "cuts": [_round_range(c) for c in cuts],
            "protected": [
                {"start": round(p.start, 3), "end": round(p.end, 3), "reason": p.reason} for p in self.protected
            ],
            "kept": [_round_range(k) for k in self.kept],
            "flags": self.flags,
            "silence": self.smap.to_json(),
            "stats": {
                "sourceS": round(self.duration, 3),
                "outputS": round(tm.output_duration_s, 3),
                "removedS": round(removed, 3),
                "cutCount": len(cuts),
                "keepCount": len(tm.keeps),
                "estimatedMaxPauseS": estimate.max,
                "estimatedP90PauseS": estimate.p90,
                "estimatedPausesOverLimit": len(estimate.over),
            },
        }

    def _voiced(self, a: int, b: int) -> bool:
        """Frames [a, b) sound like a voice (near speech level), not room tone, in a clip that has words."""
        if not self.words:
            return False
        fps = self.o.fps
        seg = self.db[int(a / fps / HOP_S) : int(b / fps / HOP_S)]
        return bool(len(seg)) and float(np.percentile(seg, 90)) >= self.smap.speech_db - 18.0

    def estimate(self, tm: TimeMap):
        """Dead-air measure on the virtual cut (the kept audio joined), so reviewers see the expected QC result."""
        hop_frames_per_video_frame = SR // tm.fps if SR % tm.fps == 0 else None
        parts = []
        for k in tm.keeps:
            if hop_frames_per_video_frame:
                a, b = k.src_start * hop_frames_per_video_frame, k.src_end * hop_frames_per_video_frame
            else:
                a, b = round(k.src_start / tm.fps * SR), round(k.src_end / tm.fps * SR)
            parts.append(self.x[a:b])
        joined = np.concatenate(parts) if parts else np.zeros(0, np.float32)
        from .audio import envelope_db

        return measure_gaps(envelope_db(joined, SR), max_pause_s=self.o.max_pause_s)

    def run(self) -> dict:
        self.load_audio()
        log(f"Planning cuts for {Path(self.source_path).name}")
        phrases = split_phrases(self.words, self.o.phrase_gap_s) if self.words else []
        self.edit_notes(phrases)
        self.retakes(phrases)
        self.restarts()
        self.fillers()
        self.hook_zone()
        self.silences()
        self.edges()
        return self.assemble()


def _ratio(a: list[str], b: list[str]) -> float:
    """Token-sequence similarity (Indel distance; rapidfuzz when installed, difflib otherwise)."""
    try:
        from rapidfuzz.distance import Indel

        return float(Indel.normalized_similarity(a, b))
    except ImportError:  # pragma: no cover - rapidfuzz is a core dependency
        return SequenceMatcher(None, a, b, autojunk=False).ratio()


def _take_similarity(a: list[str], b: list[str]) -> float:
    """How likely `a` is an earlier take of `b`: a full fuzzy match, or `a` matching the start of `b` (false start)."""
    full = _ratio(a, b)
    head = _ratio(a, b[: len(a) + 1]) if len(a) <= len(b) else 0.0
    lead = 0
    for x, y in zip(a, b, strict=False):
        if x != y:
            break
        lead += 1
    shorter = min(len(a), len(b))
    prefix = lead / shorter if shorter >= 3 and lead >= 3 else 0.0  # one take is the start of the other
    return max(full, head if len(a) >= 3 else 0.0, prefix)


def _ends_sentence(text: str) -> bool:
    return bool(re.search(r"[.?!]['\")\]]*$", text.strip()))


def _soft_break(text: str) -> bool:
    """A comma, dash, colon or ellipsis after the word (the ASR heard a break)."""
    return bool(re.search(r"(?:[,;:\u2014\u2013-]|\.\.\.|\u2026)['\")\]]*$", text.strip()))


def _subtract(ranges: list[tuple[float, float]], holes: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = ranges
    for ha, hb in holes:
        nxt = []
        for a, b in out:
            if hb <= a or ha >= b:
                nxt.append((a, b))
                continue
            if ha > a:
                nxt.append((a, ha))
            if hb < b:
                nxt.append((hb, b))
        out = nxt
    return [(a, b) for a, b in out if b > a]


def _clip(text: str, n: int = 60) -> str:
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _round_range(d: dict) -> dict:
    out = dict(d)
    out["start"] = round(float(d["start"]), 6)
    out["end"] = round(float(d["end"]), 6)
    return out


def cut_plan(payload: dict) -> dict:
    inp = CutPlanInput.model_validate(payload)
    if inp.duration_s is not None and inp.duration_s <= 0:
        raise BadInput("durationS must be positive.")
    return Planner(inp).run()


__all__ = [
    "DEFAULT_EDIT_NOTE_PHRASES",
    "DEFAULT_FILLER_WORDS",
    "DEFAULT_GUARDED_FILLERS",
    "CutPlanInput",
    "CutPlanOptions",
    "Range",
    "cut_plan",
    "split_phrases",
]
