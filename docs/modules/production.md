# Production

The daily loop in Studio, from script to scheduled post: what to film, bulk upload of your takes matched to their scripts, an edit queue that runs on its own, video approvals with timestamped notes, and scheduling the moment you approve. The step-by-step guide for owners is [Your daily workflow](../daily-workflow.md); this page covers the rules and settings behind it.

| | |
|---|---|
| Agent | Art Director (`Ad`), handing approved videos to the Publisher (`Pb`) |
| Tier | Default (on in a new workspace) |
| Setup level | [Level 2](../setup/level-2.md); scheduling needs [Level 3](../setup/level-3.md) |
| Needs | The [editing](editing.md) module and the speech-to-text model; [publishing](publishing.md) for scheduling |
| Studio pages | **Scripts**, **Edit**, **Calendar** |

## What it does

### Scripts

Scripts that are ready to film, each with shoot notes, a teleprompter (**Film it**) and **Mark as filmed**. You can upload a take with no script too; it's edited without one.

### Bulk upload, matched to scripts

Drop any number of `.mov` or `.mp4` files on **Edit**, or anywhere in Studio. Uploads go up in pieces and resume if the connection drops. Each take is saved to `media/raw/`, a cover frame is grabbed, and the **first 60 seconds are transcribed and compared with your scripts** (by the words and by the hook).

- A clear winner is linked on its own and goes straight into the edit.
- Otherwise Edit shows the best guess (**Sounds like "…" (74%)**) for you to confirm, or lets you pick the script or choose **No script, just edit it**. You can change the script on a take at any time.

### The edit queue

**Being edited** on **Edit** shows each take moving through **Up next → Cutting → Adding captions → Final checks → Ready for you**, with time left, the reason when a step stops, **Retry** and **Stop**. Takes with an earlier film-by time go first.

Between steps, production moves each edit along: it approves the cut list for you (unless **Review cuts before editing** is on), renders a saved plan, reports failures on the take, and proposes post times for the video's card. It checks every few seconds while anything is in flight, and every 10 minutes as a safety net.

### Video approvals and notes

A finished video waits under **Ready for you** on **Edit**. Press **Needs changes** to pin notes to moments on the timeline and add general notes: the Art Director resumes the same edit session with your notes and makes the next version. Or press **Looks good** to approve it.

### Scheduling on approval

After **Looks good**, **Schedule** puts the video on each platform you keep ticked, at the next open slot or a time you pick, with the captions you see (edited or not). **Download** saves the file and **Save as ready** keeps it under **Ready to post** on **Calendar**, where you can schedule it, download it or **Mark as posted** later. Every post goes through the publishing module's checks: payload validation against your connected accounts, a key per post so nothing is posted twice, tracked links, and the Instagram feed on "you post it" unless autopost is on. Scheduled posts show in **Calendar**. A video that fails to post shows under **Ready to post** with the reason and **Try again**.

## Approvals

These rules are held in code:

- A video is scheduled only when its latest version is **approved by a person**, or approved automatically while the **Art Director is on Full autopilot**. Nothing else schedules a video, so approvals always show unless you choose that.
- Scheduling a video in Studio also approves its posting plan. With the Publisher on Full autopilot, no separate posting-plan approval is needed.
- Asking for changes puts the video's approval on hold, so nothing goes out while the next version is made.

What "approvals off" means for you: [Your daily workflow](../daily-workflow.md#what-approvals-off-means).

## Settings

In `config/attentionos.config.ts`, under `modules.production.settings`:

| Setting | Default | What it does |
|---|---|---|
| `reviewCuts` | `false` | Stop at the cut list for you to approve before the edit is planned. Also a switch in **Settings** on the Edit page, which applies straight away |
| `autoLink` | `true` | Link a take to its script on its own when the match is clear |
| `autoLinkAbove` | `0.62` | How sure the match must be (0 to 1) to link on its own |
| `autoLinkMargin` | `0.12` | How far it must beat the next-best script |
| `matchWindowS` | `60` | Seconds from the start of a take that are transcribed to find its script |
| `advanceEveryS` | `12` | Seconds between checks while edits are in flight |

Posting times, platforms and Instagram autopost live in the [publishing](publishing.md) settings.

## Limits

- Matching listens to the first minute, so a take that starts with a long silence or chatter may need you to confirm the script. Saying the hook first helps.
- Without the publishing module and a connected publisher, approved videos stay approved and nothing is sent. Switch on Publishing in **Settings → Modules** and connect Zernio ([Level 3](../setup/level-3.md)).
- Editing speed depends on the machine: a small server is slower than a recent laptop.

More detail for developers: [`modules/production/README.md`](../../modules/production/README.md).
