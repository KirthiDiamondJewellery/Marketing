# production (Art Director + Publisher)

The day-to-day loop in Studio: film the script, upload the takes, the editor works the queue, you approve the video
(or send notes), and it is scheduled. Default module, setup Level 2 (uses `editing`, and `publishing` for posts).

```
Film (/film) ── teleprompter, shoot notes, "Mark as filmed"
   │ bulk upload (chunked, resumable) → media/raw/ + production_uploads
   ▼
production.match-upload ── first 60 s → ASR → token-set + hook match against the scripts
   │ clear match: linked on its own; otherwise "Sounds like X (74%)" waits in Film. Linking by hand works any time.
   ▼
editing.prep ─► cut list ─► (production.advance approves it unless "Review cuts before editing" is on)
   ─► editing.plan (LLM) ─► editing.render ─► approval (kind edit, edit_render)
   │                                   ▲
   │ notes + timestamped notes ───────┘ editing.revise {ref, fromVersion, notes, source: {channel: "studio", timestamps}}
   ▼ approve (a person, or the Art Director on autopilot)
production.schedule-approved ─► publishing schedulePost per platform (payload checks, Instagram assist, utm_content)
```

## Jobs

| Job | What it does |
|---|---|
| `production.match-upload` | Probes the take, saves a cover frame, transcribes the first `matchWindowS` seconds and ranks the scripts. Links a clear winner (`autoLinkAbove`, `autoLinkMargin`). |
| `production.advance` | The step between editing jobs. Approves cut lists when review is off, renders a saved plan nobody rendered, reports failures on the take, proposes post slots for the approval card, approves on autopilot, queues scheduling. Re-queues itself every `advanceEveryS` while anything is in flight (and runs every 10 minutes as a safety net). |
| `production.schedule-approved` | Schedules an approved video on each planned platform through the publishing module. Safe to re-run. |

## Rules held in code

- A video is scheduled only when its latest final-video approval is approved by a person, or by the system while the
  Art Director's autonomy is `autopilot` (`mayRelease`). Approvals are never skipped otherwise.
- Approving a video in Studio also approves the posting plan shown on its card (one `campaign` approval decided by the
  same person); with the Publisher on `autopilot` the publishing gate allows it without one.
- Every post goes through `schedulePost`: payload validation against the accounts snapshot, idempotency keys,
  Instagram main feed on assist unless `publishing.settings.instagram.autopost`, tracked `utm_content`.
- Queue order: prep runs get an earlier `run_after` for earlier film-by deadlines; the worker's concurrency applies.

## Settings (`modules.production.settings`)

`reviewCuts` (false), `autoLink` (true), `autoLinkAbove` (0.62), `autoLinkMargin` (0.12), `matchWindowS` (60),
`advanceEveryS` (12). Studio's edit queue saves `reviewCuts` live in the `settings` table (`production:settings`).

## Tables

`production_uploads` (one row per take: transcript, candidates, link, edit) and `production_releases` (per approved
version: proposed slots, caption overrides, scheduling outcomes).
