# editing (Art Director)

Turns raw footage into a post-ready vertical reel. Default module, setup Level 2 (needs ffmpeg, uv and the speech
model: `attentionos doctor --fix`).

The LLM only writes the plan; everything else is deterministic code. That is what keeps a reel under $0.50 of model
spend.

```
editing_start_edit ─► editing.prep (native) ─► cut list ─► person approves ─► editing.plan (LLM, Art Director)
   media-py prep, ASR provider, cut-plan        approvals queue                   EditPlan from the format template,
                                                                                  transcript and brand/house-style.md
                                                                                         │ editing_save_plan (schema + preflight "plan")
                                                                                         ▼
 person approves ◄─ approval + notification ◄─ editing.render (native): preflight "render" → render → finish (−14 LUFS)
       │                                                                 → QC → preflight "final" → output asset
       └─ "rf-12 v2 tighten the hook" ─► editing.revise (LLM, same session) ─► save plan v2 ─► render (unchanged parts reused)
```

## Jobs

| Job | Kind | Input | What it does |
|---|---|---|---|
| `editing.prep` | native | `{ref}` | proxy, silence map, contact sheet (media-py), transcript (the configured `Asr` provider), cut plan → `edit_jobs.edit_map`, status `review`, approval + message. Autopilot (or `autoApproveCutList`) skips the review. |
| `editing.plan` | llm | `{ref}` | Art Director writes the EditPlan with the `reel-editor` skill; tools validate it. Budget $0.50, Opus-class by default. |
| `editing.render` | native | `{ref, version?}` | render → finish → QC → final gate → `media_assets` render row → approval request with the file attached. |
| `editing.revise` | llm | `{ref, fromVersion, notes, attachments?, source?}` | the shape the ops module enqueues from chat. Smallest change, new version, re-render. |
| `editing.transcribe` | native | research `TranscriptionRequest` (or `{externalPostId, localPath}`) | fetch media, transcribe, reply with `research.ingest-transcript`. |

Native jobs that ask for approval end as `waiting_approval`; the owner's decision re-queues them with
`input.approval`, which approves the cut list, finalises the edit, or turns "changes asked" into a revision.

## MCP tools

`editing_start_edit`, `editing_get_edit_job`, `editing_approve_cut_list`, `editing_get_plan`, `editing_save_plan`,
`editing_request_render`, `editing_add_revision_note`, `editing_get_qc_report`.

`editing_save_plan` takes the plan without its `source` block (the approved cut list, transcript and footage are
filled in), validates it against the EditPlan schema (`@attentionos/media`) and runs the preflight `plan` gate from
`@attentionos/guardrails` (structure, assets exist, PASS evidence for every claim on screen, layout ratios, safe
zone, sign-offs). Problems come back as a list to fix.

## Settings (`config.modules.editing.settings`)

```ts
{
  defaultFormat: "raw-talking-head",          // or split-demo, news-greenscreen, popup-presenter
  asr: { model: "small", language: "en" },     // read by the asr-whispercpp provider
  cut: { hookProtectS: 0.6, wordPadS: 0.05 },  // overrides over the format's pacing.cut
  editNotePhrases: ["cut that", "editor cut"],
  autoApproveCutList: false,
  renderPreset: "veryfast",
}
```

## Files

Work files go to `<workspace>/media/work/<ref>/` (proxy, audio, transcript, render cache) and finished videos to
`<workspace>/media/renders/<ref>/v<N>.mp4`. Keep the work folder between versions: the render cache is what makes
revisions byte-stable.

## Skills

- `reel-editor`: plan first, then a deterministic render; house-style inheritance, layout modes, caption rules.
- `media-hunt`: license-clean B-roll and screenshots with a provenance log (at most 8 stills and 6 loops).
- `edit-notes`: how the owner gives spoken, cut-list and revision notes.
