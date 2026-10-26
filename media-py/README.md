# media-py

The AttentionOS media sidecar (Python 3.12, uv): probe, prep, ASR, cut planning, the cut-engine renderer, loudness
finishing and QC. Every command reads one JSON object on **stdin** and prints one JSON object on **stdout**.

```bash
uv sync                                  # core deps only: numpy, pillow, pydantic
uv sync --extra asr --extra vision       # whisper.cpp (pywhispercpp wheels) and OpenCV face tracking (YuNet)
uv sync --extra embed                    # local text embeddings for the knowledge store (fastembed, ONNX on CPU)
echo '{"path": "take1.mov"}' | uv run attentionos-media probe
```

TypeScript calls it through `mediaPy(command, input)` in `@attentionos/media`, which runs
`uv run --project <media-py> attentionos-media <command>` and adds the extras a command benefits from. The folder is
found from `$ATTENTIONOS_MEDIA_PY_DIR` (a bundled CLI points it at its shipped copy), else `<repo>/media-py`.

## Contract

- Success: the result object, exit code 0.
- Failure: `{"error": {"code", "message", "fix"?, "details"?}}`, exit 1 (runtime) or 2 (bad input). Codes are stable:
  `bad_input`, `not_found`, `ffmpeg_missing`, `model_missing`, `asr_engine_missing`, `asset_missing`, `ffmpeg_failed`,
  `download_failed`, `checksum_mismatch`, `timeout`, `internal`.
- Progress: JSON lines on stderr, `{"progress": "Rendering 4 part(s)"}`. Native libraries that print to stdout are
  redirected to stderr, so stdout always parses.
- Keys are camelCase on the wire. Times are seconds. **Source** seconds (raw recording) vs **output** seconds (after
  cuts) are documented per field; frames are `Math.round(seconds * fps)` everywhere.

## Commands

| Command | Input (main fields) | Output |
|---|---|---|
| `probe` | `{path}` | `{durationS, sizeBytes, video{codec, width, height, displayWidth, displayHeight, rotation, fps, pixFmt, …}, audio{codec, sampleRate, channels}}` |
| `prep` | `{source, workDir, fps?=30, proxy?, proxyMode?: auto\|encode, contactSheet?, asr?{engine: whispercpp\|parakeet\|stub\|none, model?, language?}, silence?{strictDb, broadDb}}` | `{probe, proxy, proxyMode: linked\|encoded, analysis, audio, silenceMap{…}, contactSheet, transcript?, transcriptPath?}` |
| `asr` | `{path, engine?, model?="small", language?, prompt?, threads?, stubWords?}` | `{language, text, words[{text, start, end, confidence?}], durationS}` |
| `cut-plan` | `{audioPath, transcript{words}, sourcePath?, durationS?, options?}` | `edit.json`: `{version, status:"review", fps, source, keepRanges[], cuts[{start, end, kind, reason, words?, evidence?}], protected[], kept[], flags[], silence, stats}` |
| `render` | `{plan (EditPlan), assets{id:{path}}, output, workDir, preset?, chunkMaxS?, parallel?, preview?}` | `{output, manifest, durationS, frames, chunks[{hash, reused}], reusedChunks, speechStem, warnings, elapsedS}` |
| `finish` | `{input, output, loudness?=-14, truePeak?=-1, lra?=11, mode?: auto\|loudnorm, tolerance?=0.5}` | `{output, before{integratedLufs, truePeakDbtp, lraLu}, after{…}, linear, method: verified\|loudnorm}` |
| `qc` | `{path, expect?{w,h,fps,codec,durationS}, loudness?{target, tolerance, truePeakMax}, pauses?{maxS, p90TargetS}, speechStem?, manifest?, previous?{path, revision}}` | `{passed, summary, checks[{id, label, status: pass\|warn\|fail\|skip, detail, fix?, value?, limit?}], measurements, fixes[]}` |
| `embed` | `{texts[], model?="BAAI/bge-small-en-v1.5", kind?: document\|query, batchSize?=64, allowDownload?=true, cacheDir?}` | `{model, dim, vectors[[float]]}` (384 dimensions for the default; model cached under `<cache>/embed`) |
| `models list\|path\|download` | `{name?\|names?, cacheDir?, force?}` (names: `small`, `whisper-base.en`, `parakeet-v2`, `face-yunet`, `fonts`, `default`, `embed`, `embed:<fastembed model>`) | listing, paths, or `{results[{name, path, status, sha256}]}` |
| `synth` | `{output, script[{word, dur}\|{pause}], width?, height?, fps?, defects?{black, freeze, clip}, video?}` | `{path, durationS, words[]}` (synthetic test clips: no real footage, no TTS) |
| `version` | – | `{version, python}` |

The EditPlan's canonical schema is the zod schema in `packages/media/src/edit-plan.ts`; its JSON Schema export is
`src/attentionos_media/schemas/edit-plan.schema.json` (regenerate with `pnpm --filter @attentionos/media export-schema`).

## Method notes

- **Cut plan** (all in source time): spoken edit notes ("cut that", configurable) remove the flubbed take; repeated
  lines keep the last full take (fuzzy match), or are flagged when the later take looks broken off; the hook's
  opening frames are protected; a pause is cut only where the strict detector (−42 dB on a 10 ms envelope) and the
  broad detector (−35 dB on a smoothed 50 ms envelope) agree, with thresholds applied as if the clip were at −14 LUFS
  and clamped above the room floor; nothing within `wordPadS` of a word is removed and word tails run until the
  audio stops; slivers without words are dropped; every cut and every kept pause has a reason. `stats` includes the
  expected dead-air result on the virtual cut.
- **Render**: ffmpeg composites each chunk (layouts, face framing, chroma key or rounded presenter window, camera
  zoompan, B-roll); PIL draws captions and graphics into an overlay layer of distinct states; audio (cut speech with
  micro-fades, synthesised SFX, ducked music) is built in numpy. Chunks are content-hashed and reused byte for byte
  across revisions, so an audio-only revision leaves the picture's stream hash identical.
- **Engine features** (fillers, restarts, face tracking, motion, the look, voice chain, crossfades, auto SFX,
  encoder choice): see `docs/editing/engine.md` for the feature matrix and every plan field.
- **QC** measures the real file: format, black frames, freezes (planned stills excepted), clipping (per channel),
  loudness and true peak, dead air on the speech stem (> 0.15 s fails, p90 target 0.10 s), caption safe zone from
  the render manifest, top-band brightness, and the stream hash against a previous render.

## Assets policy

Nothing third-party is committed. Fonts (OFL: Montserrat, Geist, Instrument Serif, Caveat), the ASR models
(whisper.cpp MIT; Parakeet CC-BY-4.0) and the YuNet face model (MIT) are fetched by `models download` from the
manifest in `models.py`, which records each file's URL, license, size and SHA-256. Sound effects are synthesised in
code (CC0 by construction). Without fonts, Pillow's built-in font is used so renders and QC still work.

## Development

```bash
uv run ruff check && uv run pytest            # fast and slow tests (synthetic clips, ~1 min)
ATTENTIONOS_PERF=1 uv run pytest -k perf -s    # timing for a 60 s synthetic clip
ATTENTIONOS_TEST_ASR=1 uv run --extra asr pytest -k real_whisper   # downloads the ~500 MB model
```
