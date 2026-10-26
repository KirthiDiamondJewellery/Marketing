/**
 * Source → output time map (mirror of `media-py/src/attentionos_media/timemap.py`; both quantise with
 * `Math.round(seconds * fps)` and must agree frame for frame).
 *
 * Source and output times are different branded number types, so the bug class this module exists to prevent
 * (comparing output-mapped word times with source-time pauses) is a type error:
 *
 *   const pause = sourceRange(4.0, 4.4);            // a silence found in the raw recording
 *   const beat = outputRange(2.9, 3.6);             // a beat in the edited video
 *   overlaps(pause, beat)                           // ✗ does not compile: different time bases
 *   overlaps(map.sourceRangeToOutput(pause)[0], beat) // ✓ map first, then compare
 */

declare const SOURCE: unique symbol;
declare const OUTPUT: unique symbol;
/** Seconds in the raw recording. */
export type SourceSeconds = number & { readonly [SOURCE]: true };
/** Seconds in the edited video. */
export type OutputSeconds = number & { readonly [OUTPUT]: true };
export type SourceFrame = number & { readonly [SOURCE]: "frame" };
export type OutputFrame = number & { readonly [OUTPUT]: "frame" };

export type SourceRange = { start: SourceSeconds; end: SourceSeconds };
export type OutputRange = { start: OutputSeconds; end: OutputSeconds };

export const src = (s: number) => s as SourceSeconds;
export const out = (s: number) => s as OutputSeconds;
export const sourceRange = (start: number, end: number): SourceRange => ({ start: src(start), end: src(end) });
export const outputRange = (start: number, end: number): OutputRange => ({ start: out(start), end: out(end) });

/** Overlap test that only accepts two ranges in the same time base. */
export function overlaps(a: SourceRange, b: SourceRange): boolean;
export function overlaps(a: OutputRange, b: OutputRange): boolean;
export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

/** JavaScript's Math.round, shared with media-py (`floor(x * fps + 0.5)`). */
export function toFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export type Keep = { srcStart: SourceFrame; srcEnd: SourceFrame; outStart: OutputFrame };

export class TimeMap {
  readonly outputFrames: number;
  private readonly srcStarts: number[];
  private readonly outStarts: number[];

  private constructor(readonly fps: number, readonly sourceFrames: number, readonly keeps: readonly Keep[]) {
    this.outputFrames = keeps.reduce((n, k) => n + (k.srcEnd - k.srcStart), 0);
    this.srcStarts = keeps.map((k) => k.srcStart);
    this.outStarts = keeps.map((k) => k.outStart);
  }

  /** Keep ranges in SOURCE seconds → frames; sorted, overlapping or touching ranges merged, clamped to the source. */
  static fromKeepRanges(ranges: readonly { start: number; end: number }[], fps: number, sourceDurationS: number): TimeMap {
    if (!(fps > 0)) throw new RangeError("fps must be positive");
    const sourceFrames = toFrame(sourceDurationS, fps);
    const frames = ranges
      .map((r) => [Math.max(0, toFrame(r.start, fps)), Math.min(sourceFrames, toFrame(r.end, fps))] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: [number, number][] = [];
    for (const [a, b] of frames) {
      if (b <= a) continue;
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    let o = 0;
    const keeps: Keep[] = merged.map(([a, b]) => {
      const k = { srcStart: a as SourceFrame, srcEnd: b as SourceFrame, outStart: o as OutputFrame };
      o += b - a;
      return k;
    });
    return new TimeMap(fps, sourceFrames, keeps);
  }

  /** The complement: drop intervals (SOURCE seconds) → keep ranges. */
  static fromDrops(drops: readonly { start: number; end: number }[], fps: number, sourceDurationS: number): TimeMap {
    const sorted = [...drops].sort((a, b) => a.start - b.start);
    const keeps: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const d of sorted) {
      if (d.start > cursor) keeps.push({ start: cursor, end: d.start });
      cursor = Math.max(cursor, d.end);
    }
    if (cursor < sourceDurationS) keeps.push({ start: cursor, end: sourceDurationS });
    return TimeMap.fromKeepRanges(keeps, fps, sourceDurationS);
  }

  static identity(fps: number, sourceDurationS: number): TimeMap {
    return TimeMap.fromKeepRanges([{ start: 0, end: sourceDurationS }], fps, sourceDurationS);
  }

  get outputDurationS(): OutputSeconds {
    return out(this.outputFrames / this.fps);
  }

  /** Output frame of a kept source frame; null when that frame was cut. */
  srcToOut(frame: SourceFrame | number): OutputFrame | null {
    const i = upperBound(this.srcStarts, frame) - 1;
    const k = this.keeps[i];
    if (!k || frame >= k.srcEnd) return null;
    return (k.outStart + frame - k.srcStart) as OutputFrame;
  }

  /** Like srcToOut, but a cut frame snaps to where playback resumes. */
  srcToOutSnap(frame: SourceFrame | number): OutputFrame {
    for (const k of this.keeps) {
      if (frame < k.srcStart) return k.outStart;
      if (frame < k.srcEnd) return (k.outStart + frame - k.srcStart) as OutputFrame;
    }
    return this.outputFrames as OutputFrame;
  }

  outToSrc(frame: OutputFrame | number): SourceFrame {
    const last = this.keeps[this.keeps.length - 1];
    if (!last) return 0 as SourceFrame;
    if (frame >= this.outputFrames) return last.srcEnd;
    const k = this.keeps[Math.max(0, upperBound(this.outStarts, frame) - 1)]!;
    return (k.srcStart + frame - k.outStart) as SourceFrame;
  }

  /** Output seconds of a source time; null when it was cut. */
  toOutput(t: SourceSeconds): OutputSeconds | null {
    const f = this.srcToOut(toFrame(t, this.fps));
    return f === null ? null : out(f / this.fps);
  }

  /** Source seconds playing at an output time. */
  toSource(t: OutputSeconds): SourceSeconds {
    return src(this.outToSrc(toFrame(t, this.fps)) / this.fps);
  }

  /** Output ranges covering the kept part of a source range (a range spanning a cut maps to several). */
  sourceRangeToOutput(r: SourceRange): OutputRange[] {
    const a = toFrame(r.start, this.fps);
    const b = toFrame(r.end, this.fps);
    const res: OutputRange[] = [];
    for (const k of this.keeps) {
      const lo = Math.max(a, k.srcStart);
      const hi = Math.min(b, k.srcEnd);
      if (hi > lo) res.push(outputRange((k.outStart + lo - k.srcStart) / this.fps, (k.outStart + hi - k.srcStart) / this.fps));
    }
    return res;
  }

  /** Source pieces that play during an output range, in playback order. */
  outputRangeToSource(r: OutputRange): SourceRange[] {
    const a = toFrame(r.start, this.fps);
    const b = toFrame(r.end, this.fps);
    const res: SourceRange[] = [];
    for (const k of this.keeps) {
      const len = k.srcEnd - k.srcStart;
      const lo = Math.max(a, k.outStart);
      const hi = Math.min(b, k.outStart + len);
      if (hi > lo) res.push(sourceRange((k.srcStart + lo - k.outStart) / this.fps, (k.srcStart + hi - k.outStart) / this.fps));
    }
    return res;
  }

  /** Maps source-time words to output time; words that were cut are dropped. */
  mapWords<W extends { start: number; end: number }>(words: readonly W[]): (Omit<W, "start" | "end"> & { start: OutputSeconds; end: OutputSeconds })[] {
    const res: (Omit<W, "start" | "end"> & { start: OutputSeconds; end: OutputSeconds })[] = [];
    for (const w of words) {
      const a = toFrame(w.start, this.fps);
      const b = Math.max(toFrame(w.end, this.fps), a + 1);
      const spans = this.sourceRangeToOutput(sourceRange(a / this.fps, b / this.fps));
      if (spans.length === 0) continue;
      res.push({ ...w, start: spans[0]!.start, end: spans[spans.length - 1]!.end });
    }
    return res;
  }

  /** Keep ranges as SOURCE seconds (frame-aligned). */
  keepRanges(): SourceRange[] {
    return this.keeps.map((k) => sourceRange(k.srcStart / this.fps, k.srcEnd / this.fps));
  }

  /** Dropped source ranges (the complement of the keeps). */
  droppedRanges(): SourceRange[] {
    const res: SourceRange[] = [];
    let cursor = 0;
    for (const k of this.keeps) {
      if (k.srcStart > cursor) res.push(sourceRange(cursor / this.fps, k.srcStart / this.fps));
      cursor = k.srcEnd;
    }
    if (cursor < this.sourceFrames) res.push(sourceRange(cursor / this.fps, this.sourceFrames / this.fps));
    return res;
  }

  /** Output times where the viewer sees a cut. */
  joins(): OutputSeconds[] {
    return this.keeps.slice(1).map((k) => out(k.outStart / this.fps));
  }
}

function upperBound(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
