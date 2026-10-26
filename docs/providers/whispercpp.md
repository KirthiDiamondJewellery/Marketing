# whisper.cpp

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) is a fast, open-source speech-to-text engine that runs on your own machine. AttentionOS uses it to get a **word-by-word transcript with timestamps**, which every cut, caption and edit note depends on.

| | |
|---|---|
| Interface | Speech to text (ASR) |
| Config | `providers.asr: "whispercpp"` (default) |
| Key | None |
| Cost | Free; runs locally |
| Download | About 500 MB for the default model |
| Setup level | [Level 2](../setup/level-2.md) |

## Set up (about 10 minutes, mostly downloading)

```bash
./aos doctor --fix
```

Doctor installs the Python video tools with `uv`, downloads the speech model into your workspace's local cache (`.attentionos/`, never committed), and transcribes a short sample clip to confirm everything works.

## Why local

- Your footage never leaves your machine for transcription.
- No per-minute fees.
- Works offline.

## Speed

On Apple Silicon and recent PCs, a one-minute clip takes seconds. Older machines take longer but work. GPU acceleration is used when available and never required.

## Accuracy tips

- Record close to the mic, in a quiet room.
- Names and niche terms: add them to `brand/voice.md` under a vocabulary section. They are passed to the model as hints.
- If a word is wrong in the captions, reply to the edit with the fix ("rf-12 v2 it's 'ROI', not 'our way'"), then save it as a lesson with `/attention:lesson`.

## Alternatives

| Provider | When to use it |
|---|---|
| Parakeet (planned) | A fast local alternative on some hardware. The `media-py` engine exists (`parakeet` extra), but the provider that connects it to `asr: "parakeet"` isn't shipped yet |
| OpenAI Whisper API (planned) | No local install; pay per minute; footage is sent to the API |

Whichever you choose, word timestamps are required; AttentionOS won't use an engine that can't provide them.

## Troubleshooting

**"Model not found"** · Run `./aos doctor --fix` again; the download may have been interrupted.

**Out of memory** · Close other heavy apps, or ask doctor to use a smaller model.
