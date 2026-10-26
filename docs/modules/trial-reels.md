# Trial reels

Turn clean reels (no captions, no title) into a day of Instagram **trial reel** variations and schedule them as trial reels only. Each variation is the same video with a different speed (up to 1.1×), colour filter, caption style, title style and wording, position and hashtag set: the changes you would otherwise make by hand in an editing app. AttentionOS renders and checks every variation, shows you the preview, and schedules nothing until you say so.

Instagram shows trial reels to people who don't follow you yet. They never appear on your grid; you decide whether one is shown to your followers (graduation).

| | |
|---|---|
| Agent | Publisher (`Pb`) |
| Tier | Default (on in a new workspace) |
| Setup level | Making them: [Level 2](../setup/level-2.md). Scheduling: [Level 3](../setup/level-3.md) with Zernio, plus the trial reels notice |
| Needs | [editing](editing.md) (clean renders, speech-to-text), [publishing](publishing.md) (posting) |
| Studio pages | **Edit** (Recently done, upload, Trial reels), **Calendar** (Ready to post, posts marked **Trial reel**) |
| Tools | `trial_reels_sources`, `trial_reels_make`, `trial_reels_status`, `trial_reels_schedule`, `trial_reels_cancel` |

## How it works

```
clean reel ──► word timings ──► plan ──► render ──► check ──► preview ──► your OK ──► Instagram (trial only)
  edit or        whisper.cpp     seeded    ffmpeg    format,     Studio     approval     spread over the day,
  upload                         by day              captions,                           alternating videos
                                                     title, ask
```

1. **A clean reel.** Either a finished or approved video from Edit, which AttentionOS renders once more **without captions or on-screen text** (same cuts, framing, sound and colour; pictures such as screenshots stay), or a clean reel you upload yourself.
2. **Word timings.** The clean video is transcribed with your speech-to-text (whisper.cpp by default), so the captions follow the words exactly.
3. **The plan.** The day's total (9 by default) is split evenly across the day's videos. Each variation gets its own speed, colour filter, caption style, title style and wording, small position changes and 5 reshuffled hashtags. Speed, colour and caption style never repeat together within a video. The plan is seeded by the day and the video, so the same inputs always give the same set.
4. **Render.** Every variation is encoded fresh as H.264/AAC, 1080×1920, 30 fps, with the original file's metadata removed. Speed changes keep the voice's pitch.
5. **Check.** Each file is checked before anything can be scheduled: the format; the length for its speed; three captions found on screen at the moment they should be (the pixels are compared with the drawn caption); the title on screen at the start and gone after its time; the end ask on screen near the end and not before; no two files byte-identical; no two looks the same within a video. A batch that fails can't be scheduled.
6. **Preview.** Studio shows every variation (tap to play), its time, title and a sample caption.
7. **Your OK.** **Schedule N trial reels** is your approval of the batch. Posts take turns between videos and are spread evenly across the posting window (08:00 to 21:00 in your timezone by default).

### The variations

| Knob | Values |
|---|---|
| Speed | 1.03× to 1.10× (`speeds`), voice pitch kept |
| Colour | warm, cool, punch, soft, vivid, moody, golden (light; black bars stay black) |
| Captions | white outline, boxed active word, yellow active word, one big slanted word, condensed caps; nudged up or down |
| Title | plain caps, white box, black box, small plain; your wordings in turn; nudged |
| End ask (optional) | white or black box, from the start of the last sentence |
| File | re-encoded, original metadata removed |
| Post caption | your caption line (if any) plus 5 of your hashtags, reshuffled |

Captions and titles use the open-licence fonts AttentionOS already uses for edits (Montserrat and Geist, fetched by `attentionos doctor --fix`); condensed and slanted looks are made from them, so nothing else needs installing. Emoji are left out of titles.

## In Studio

- **Edit → Recently done**, or **Calendar → Ready to post**: **Make trial reels** on a video.
- **Edit → upload**: tick **These are clean reels for trial reels** before dropping files. They wait under **Trial reels** on Edit with **Make trial reels**.
- The form: **Title** (yours), optional **other wordings** (the same words reordered), **Caption line** (word for word; required with the keyword when the video asks for a comment), **Hashtags** (prefilled from the video's Instagram caption and your hashtag sets; at least 5), **Layout** (talking head: title above the head the whole video; split screen: title in the top bar for 3.5 seconds), an optional **End ask**, the **Day** (tomorrow by default) and **How many** (your daily total).
- Progress shows while they render. Close the panel any time; **Edit → Trial reels** keeps the batch.
- Scheduled trial reels show on **Calendar** as **Trial reel · …**, Instagram only. Open one to cancel it; **Cancel the ones not live yet** cancels the rest of a day.

From chat: *"make trial reels from yesterday's video"*. The Chief of Staff finds the video, asks for your title if it needs one, makes the batch and tells you when the preview is ready. It can ask for your OK but can't give it.

## Rules the code enforces

- **Trial reels only.** Every post carries Instagram's trial flag and is never shared to the feed. Graduation is **manual** unless you set `graduation: "auto"`.
- **Your OK first.** Nothing is scheduled until a person approves the batch (the Studio button, or the approval card). Agents can't approve.
- **50 posts per 24 hours** on the account, counting every other post; the day is trimmed to fit.
- **Your words only.** Other title wordings may only reorder your title's words (plus small words like "the" or "your"); anything else is refused. The caption line is posted word for word.
- **Never twice.** A ledger records every variation before it is handed to your publisher. Re-runs skip everything in it; one whose send was never confirmed is shown, not resent. A video can't get a second batch on a day that already has trial reels scheduled.
- **Prove it once per account.** Until you've checked one live trial reel, a batch sends **one**, right away. When it's live, open your profile: if it is **not** on your grid, press **It stayed off my grid** (on the batch or on that post in Calendar). Then schedule the rest. If it is on your grid, press **It's on my grid: stop** and tell us. The check is stored per account in your database, never shipped.
- **The trial reels notice** (`acknowledgements.trialReelsRisk`) must be accepted before anything is scheduled. Making and previewing don't need it.

## Settings

`modules["trial-reels"].settings` in `config/attentionos.config.ts`:

| Setting | Default | What it does |
|---|---|---|
| `dailyTotal` | `9` | Trial reels a day in total, split across the day's videos (1 to 50) |
| `dailyCap` | `50` | Rolling 24-hour cap on the Instagram account, counting all posts |
| `speeds` | `[1.03 … 1.10]` | Speeds a variation may use (above 1, at most 1.1). The count must share no factor with 7 or 5 (8 works) |
| `window` | `{ start: "08:00", end: "21:00" }` | Posts are spread evenly across this window, in your timezone |
| `graduation` | `"manual"` | `"auto"` lets Instagram show a trial reel to followers when it performs well |
| `hashtagSets` | `{}` | Reusable topic sets, e.g. `{ tips: ["smallbusinesstips", …] }` (5 to 30 each) |

```ts
modules: {
  "trial-reels": { settings: { dailyTotal: 9, window: { start: "08:00", end: "21:00" } } },
},
acknowledgements: { trialReelsRisk: true },
```

## Publishing details

Posts go through the [publishing](publishing.md) module with `options.instagram.trialReel = true`. With [Zernio](../providers/zernio.md) that becomes `platformSpecificData.trialParams.graduationStrategy` (`"MANUAL"`, or `"SS_PERFORMANCE"` for automatic graduation) with `shareToFeed: false`; Blotato's adapter maps the same option to `trial.graduationStrategy`. Each post has its own idempotency key (`trial-<day>-<variation>`), so the publisher never gets it twice.

## Files

| Where | What |
|---|---|
| `media/renders-clean/<edit>/v<n>.mp4` | The clean render of an edit version (made once, reused) |
| `media/trial-reels/<day>/<batch>/out/` | The variations |
| `media/trial-reels/<day>/<batch>/preview.jpg`, `posters/` | One frame per variation |
| `media/trial-reels/<day>/<batch>/manifest.json`, `verify.json` | What was rendered and the check results |

Tables: `trial_reel_batches` (one row per day's batch) and `trial_reel_posts` (the ledger). After the day has posted you can delete its `out/` folder; keep the rest.

The renderer is `attentionos-media trial-plan | trial-render | trial-verify` (JSON in, JSON out), so it can also be run by hand.

## Limits

- Whether Instagram treats each copy as a new video can't be verified. Watch reach and Account Status the first week, and stop if either drops.
- A reel with almost no speech can't be made into trial reels (the captions come from the words).
- Trial reel times come from the day's plan, so they aren't dragged on the calendar one by one; cancel and make a new batch for another day instead.
