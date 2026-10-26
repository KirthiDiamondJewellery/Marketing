"""Typed JSON contracts for every command.

The canonical EditPlan schema is the zod schema in `packages/media/src/edit-plan.ts`; its JSON Schema export lives
next to this file (`edit-plan.schema.json`) and the test suite checks these pydantic models accept everything that
schema accepts. JSON keys are camelCase on the wire; Python attributes are snake_case.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Wire(BaseModel):
    """camelCase on the wire, strict about unknown keys (catches typos in command input)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class Lenient(Wire):
    """For documents produced by the TypeScript side (EditPlan, edit.json): unknown keys are ignored so a newer
    plan never breaks an older sidecar."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


# --- shared -------------------------------------------------------------------------------------------------


class Word(Lenient):
    text: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    confidence: float | None = None


class Transcript(Lenient):
    language: str = "en"
    text: str = ""
    words: list[Word] = Field(default_factory=list)
    duration_s: float = Field(default=0.0, ge=0)


class Range(Lenient):
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class ReasonRange(Range):
    reason: str = ""
    kind: str | None = None


# --- EditPlan (mirror of packages/media/src/edit-plan.ts) ----------------------------------------------------

LayoutMode = Literal["full", "split", "fullVisual", "inset"]
Fit = Literal["cover", "contain"]
OverlayKind = Literal["headline", "post-card", "screenshot", "logo", "lower-third", "chart"]
SfxKind = Literal["whoosh", "swipe", "pop", "riser", "click", "hit", "ding", "zoom", "impact", "glitch", "soft", "tick"]
CaptionStyle = Literal["bold-pop", "clean", "subtitle", "boxed", "serif", "none"]
FontId = Literal["montserrat", "geist", "instrument-serif", "caveat"]


class SourceMedia(Lenient):
    asset_id: str | None = None
    path: str
    duration_s: float = Field(gt=0)
    width: int | None = None
    height: int | None = None
    fps: float | None = None


class PlanTimeMap(Lenient):
    fps: int = 30
    keep_ranges: list[Range]
    dropped: list[ReasonRange] = Field(default_factory=list)
    protected: list[ReasonRange] = Field(default_factory=list)


class PlanSource(Lenient):
    media: SourceMedia
    transcript: Transcript = Field(default_factory=Transcript)
    time_map: PlanTimeMap


class Point(Lenient):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class VisualRef(Lenient):
    asset_id: str
    in_: float = Field(default=0.0, ge=0, alias="in")
    loop: bool = False


class ChromaKey(Lenient):
    color: str = "#00FF00"
    similarity: float = Field(default=0.3, gt=0, le=1)
    blend: float = Field(default=0.08, ge=0, le=1)


class InsetSpec(Lenient):
    scale: float = Field(default=0.45, ge=0.2, le=0.95)
    anchor: Literal["bottom-left", "bottom-right", "bottom-center"] = "bottom-center"
    key: ChromaKey | None = None
    matte_asset_id: str | None = None
    radius: int = 36


class SpeakerSpec(Lenient):
    position: Literal["top", "bottom"] = "bottom"
    focus: Literal["face", "center"] | Point = "face"
    # Follow the face inside a shot when the speaker moves (smoothed, dead-zoned); false = one position per shot.
    track: bool = True


class LayoutSegment(Lenient):
    mode: LayoutMode
    start: float = Field(ge=0)
    dur: float = Field(gt=0)
    fit: Fit = "cover"
    visual: VisualRef | None = None
    speaker: SpeakerSpec = Field(default_factory=SpeakerSpec)
    inset: InsetSpec | None = None
    split_ratio: float = Field(default=0.5, ge=0.3, le=0.7)


class Layout(Lenient):
    segments: list[LayoutSegment] = Field(default_factory=list)


class SafeZone(Lenient):
    """Margins (pixels, or fractions of the frame when ≤ 1) that captions and graphics never enter. The preset fills
    any margin left out."""

    preset: Literal["universal", "reels", "tiktok", "shorts"] = "universal"
    top: float | None = Field(default=None, ge=0)
    bottom: float | None = Field(default=None, ge=0)
    left: float | None = Field(default=None, ge=0)
    right: float | None = Field(default=None, ge=0)


class Captions(Lenient):
    style: CaptionStyle = "bold-pop"
    emphasis_words: list[str] = Field(default_factory=list)
    safe_zone: SafeZone = Field(default_factory=SafeZone)
    position: Literal["lower", "middle", "seam"] = "lower"
    max_words: int | None = Field(default=None, ge=1, le=10)
    case: Literal["upper", "as-is", "lower"] | None = None
    font: FontId | None = None
    replace: dict[str, str] = Field(default_factory=dict)
    # The spoken word's colour and the emphasis colour (#RRGGBB; the house style's brand colour goes here).
    active_color: str | None = None
    emphasis_color: str | None = None
    # Size multiplier on the style's base size ("bigger captions" = 1.15).
    scale: float | None = Field(default=None, ge=0.6, le=1.6)


class Overlay(Lenient):
    id: str | None = None
    kind: OverlayKind
    at: float = Field(ge=0)
    dur: float = Field(gt=0)
    asset_id: str | None = None
    evidence_id: str | None = None
    text: str | None = None
    subtext: str | None = None
    position: Literal["top", "middle", "lower"] | None = None
    props: dict[str, Any] = Field(default_factory=dict)


class Provenance(Lenient):
    source: str
    url: str | None = None
    author: str | None = None
    retrieved_at: str | None = None
    note: str | None = None


class Broll(Lenient):
    asset_id: str
    at: float = Field(ge=0)
    dur: float = Field(gt=0)
    in_: float = Field(default=0.0, ge=0, alias="in")
    fit: Fit = "cover"
    provenance: Provenance
    license: str


class Sfx(Lenient):
    kind: SfxKind
    at: float = Field(ge=0)
    gain_db: float = 0.0


class Music(Lenient):
    asset_id: str
    gain_db: float = -20.0
    duck: bool = True
    license: str | None = None


class VoiceChain(Lenient):
    """Clean-up applied to the voice before it is cut (all levels are measured, not guessed)."""

    denoise: Literal["auto", "off", "light", "strong"] = "auto"
    deess: bool = True
    compress: bool = True
    highpass_hz: float = Field(default=80.0, ge=0, le=300)


class AudioPlan(Lenient):
    sfx: list[Sfx] = Field(default_factory=list)
    music: Music | None = None
    loudness: float = -14.0
    true_peak: float = -1.0
    voice: VoiceChain = Field(default_factory=VoiceChain)
    # Equal-power crossfade at every join, so cuts never click (0 = a 4 ms fade only).
    crossfade_ms: float = Field(default=16.0, ge=0, le=80)
    # Synthesised sounds added by code: on layout changes, on punch-ins, or both. Plan `sfx` entries always play.
    auto_sfx: Literal["off", "layout", "punches", "all"] = "off"


class CameraMove(Lenient):
    kind: Literal["zoom", "push"]
    at: float = Field(ge=0)
    dur: float = Field(gt=0)
    scale: float = Field(default=1.12, ge=1.0, le=2.0)
    focus: Point | None = None


class ExportSpec(Lenient):
    w: int = 1080
    h: int = 1920
    fps: int = 30
    codec: Literal["h264"] = "h264"
    bitrate: str = "12M"
    audio_bitrate: str = "192k"
    crf: int = Field(default=18, ge=10, le=35)
    # auto: libx264 (deterministic, fast on CPU); hardware: VideoToolbox/NVENC/VAAPI when present, else libx264.
    encoder: Literal["auto", "x264", "hardware"] = "auto"


class Motion(Lenient):
    """Camera motion added by code in `full` segments (explicit `camera` moves are added on top)."""

    # Alternate the framing between 1.0 and 1+jumpCutZoom at every cut, so jump cuts read as intentional.
    jump_cut_zoom: float = Field(default=0.07, ge=0, le=0.25)
    # Eased punch-ins on emphasis words, on sentence starts, or never.
    punch_ins: Literal["off", "emphasis", "sentences"] = "emphasis"
    punch_scale: float = Field(default=0.06, ge=0, le=0.25)
    # At most one punch-in every this many seconds.
    min_gap_s: float = Field(default=4.0, ge=0.5, le=30)
    # A slow push-in over the first shot (the hook).
    hook_push: bool = True
    max_zoom: float = Field(default=1.18, ge=1.0, le=2.0)


class Look(Lenient):
    """Automatic picture correction from measured statistics: levels, white balance, gentle contrast."""

    color: Literal["auto", "off"] = "auto"
    strength: float = Field(default=0.7, ge=0, le=1)
    grade: Literal["none", "pop", "vivid", "warm", "cool", "mono"] = "none"
    # Light sharpening after the upscale of a reframed source (auto = only when the crop is upscaled).
    sharpen: Literal["auto", "off", "on"] = "auto"


class EditPlan(Lenient):
    version: int = 1
    source: PlanSource
    format: str
    layout: Layout = Field(default_factory=Layout)
    captions: Captions = Field(default_factory=Captions)
    overlays: list[Overlay] = Field(default_factory=list)
    broll: list[Broll] = Field(default_factory=list)
    audio: AudioPlan = Field(default_factory=AudioPlan)
    camera: list[CameraMove] = Field(default_factory=list)
    export: ExportSpec = Field(default_factory=ExportSpec)
    motion: Motion = Field(default_factory=Motion)
    look: Look = Field(default_factory=Look)
