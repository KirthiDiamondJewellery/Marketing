from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from attentionos_media.asr import transcribe
from attentionos_media.models import ARTIFACTS, GROUPS, models_command, resolve
from attentionos_media.render.safezone import PRESETS, safe_box
from attentionos_media.render.sfx import LEVEL, SYNTHS, synth
from attentionos_media.schemas import EditPlan, SafeZone

from .conftest import make_clip, run_cli, sentence

SCHEMA = Path(__file__).resolve().parents[1] / "src" / "attentionos_media" / "schemas" / "edit-plan.schema.json"


def test_sfx_are_deterministic_and_levelled():
    for kind in SYNTHS:
        a, land_a = synth(kind, 3)
        b, land_b = synth(kind, 3)
        assert np.array_equal(a, b) and land_a == land_b
        assert abs(float(np.abs(a).max()) - LEVEL[kind]) < 0.02
        assert 0 <= land_a < len(a)
        assert a.dtype == np.float32 and len(a) > 100


def test_safe_zone_keeps_captions_out_of_bottom_fifth_and_button_column():
    for preset in PRESETS:
        b = safe_box(SafeZone(preset=preset))
        assert b.bottom <= 1920 * 0.8
        assert b.right <= 940
        assert b.top >= 200
    scaled = safe_box(SafeZone(), 540, 960)
    assert scaled.bottom == 740


def test_models_manifest_has_license_and_checksum():
    for a in ARTIFACTS.values():
        assert len(a.sha256) == 64 and a.bytes > 0 and a.license and a.url.startswith("https://")
        if a.kind == "font":
            assert a.license == "OFL-1.1"
    assert resolve("small").name == "whisper-small"
    assert all(n in ARTIFACTS for n in GROUPS["default"])
    listing = models_command("list", {"cacheDir": "/nonexistent-cache"})
    assert any(m["name"] == "whisper-small" and not m["installed"] for m in listing["models"])


def test_stub_asr_cleans_overlaps(tmp_path):
    clip = make_clip(tmp_path / "s.wav", sentence("one two three"), video=False)
    words = [
        {"text": "one", "start": 0.0, "end": 0.4},
        {"text": "two", "start": 0.3, "end": 0.6},
        {"text": " ", "start": 0.6, "end": 0.7},
    ]
    t = transcribe({"path": clip["path"], "engine": "stub", "stubWords": words})
    assert [w["text"] for w in t["words"]] == ["one", "two"]
    assert t["words"][1]["start"] >= t["words"][0]["end"]


def test_cli_contract(tmp_path):
    code, out = run_cli(["probe"], {"path": str(tmp_path / "missing.mp4")})
    assert code == 1 and out["error"]["code"] == "not_found" and out["error"]["fix"]
    code, out = run_cli(["nope"])
    assert code == 2 and out["error"]["code"] == "unknown_command"
    code, out = run_cli(["cut-plan"], {"transcript": {}})
    assert code == 2 and out["error"]["code"] == "bad_input" and out["error"]["details"]["issues"]
    code, out = run_cli(["version"])
    assert code == 0 and out["version"]
    clip = make_clip(tmp_path / "c.mp4", sentence("probe me please"), width=540, height=960)
    code, out = run_cli(["probe"], {"path": clip["path"]})
    assert code == 0 and out["video"]["displayHeight"] == 960 and out["audio"]["codec"] == "aac"
    code, out = run_cli(["models", "list"], {"cacheDir": str(tmp_path)})
    assert code == 0 and out["models"]


@pytest.mark.skipif(not SCHEMA.exists(), reason="run `pnpm --filter @attentionos/media export-schema` first")
def test_exported_json_schema_and_pydantic_agree():
    import jsonschema

    schema = json.loads(SCHEMA.read_text())
    fixture = json.loads((Path(__file__).parent / "fixtures" / "plan.json").read_text())
    jsonschema.validate(fixture, schema)
    plan = EditPlan.model_validate(fixture)
    assert plan.layout.segments[1].visual is not None and plan.layout.segments[1].visual.in_ == 1.5
    bad = dict(fixture, layout={"segments": [{"mode": "sideways", "start": 0, "dur": 1}]})
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(bad, schema)


@pytest.mark.asr
@pytest.mark.skipif(
    not os.environ.get("ATTENTIONOS_TEST_ASR"), reason="opt-in: ATTENTIONOS_TEST_ASR=1 downloads the ~500 MB model"
)
def test_real_whisper_model(tmp_path):
    from attentionos_media.models import download

    model = os.environ.get("ATTENTIONOS_TEST_ASR_MODEL", "small")
    download(f"whisper-{model}")
    clip = make_clip(
        tmp_path / "speechlike.wav",
        [*sentence("alpha beta gamma delta"), {"pause": 0.5}, *sentence("epsilon zeta")],
        video=False,
    )
    t = transcribe({"path": clip["path"], "engine": "whispercpp", "model": model, "language": "en"})
    # Synthetic speech-like noise is not language: the contract is shape, not content.
    assert set(t) >= {"language", "text", "words", "durationS"}
    assert abs(t["durationS"] - clip["durationS"]) < 0.1
    for w in t["words"]:
        assert 0 <= w["start"] <= w["end"] <= t["durationS"] + 0.01
    sample = os.environ.get("ATTENTIONOS_TEST_ASR_SAMPLE")  # optional: a real speech file you own
    if sample:
        t2 = transcribe({"path": sample, "engine": "whispercpp", "model": model})
        assert t2["words"], "a real speech sample should produce words"
