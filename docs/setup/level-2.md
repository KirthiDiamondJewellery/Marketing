# Level 2: edit

**Time:** about 20 minutes on top of [Level 1](level-1.md), plus the time to film · **Cost:** $0 for tools; under $0.50 of model use per reel is the target (on your Claude plan by default)

By the end of this guide, the takes you film on your phone become finished vertical videos: dead air and retakes cut, captions burned in, a layout from your format, loudness fixed and a quality check passed. You watch each one in Studio, leave notes on the timeline if something's off, and approve it.

Everything you need is already in the install: ffmpeg, the video tools and the speech-to-text engine. There's nothing to install by hand.

---

## Before you start

| You need | Why |
|---|---|
| Level 1 done | Edits use your Brand Kit, your formats and your scripts |
| The speech-to-text model (about 500 MB, downloads by itself once) | Transcribes your takes on your own machine, so your footage never leaves it |
| About 1 GB of free disk space, plus room for your footage | Raw takes and renders live in your workspace's `media/` folder |

## Step 1. Check the speech model is ready (1 minute)

AttentionOS downloads the speech-to-text model (about 500 MB) by itself the first time it starts, and fetches it on first use if that hasn't finished. To check: `./aos doctor` shows **Speech-to-text model** passing, or in Studio **Settings → Checkup**. If it failed (for example, no internet at the time), `./aos doctor --fix` retries.

## Step 2. Check editing is on (1 minute)

Pressing **Start** during setup switches editing on for you. To check: **Settings → Modules**, and make sure **Editing** is on. **Production** (the daily loop: Scripts, Edit, Calendar) is on by default.

## Step 3. Choose your formats and house style (about 10 minutes)

A **format** is the layout of a video: raw talking head, split demo, news green screen or pop-up presenter. Each piece in your brief already names one, with **shoot directions** you see on the script before you shoot.

Your **house style** is how every edit should look and sound: caption style and size, emphasis, pacing, sound effects, what to avoid. It lives in your Brand Kit as `brand/house-style.md`. Open **Brand Kit** in Studio to read and edit it (changes save straight to your workspace), or use any editor. Keep it in plain words ("captions bigger, two lines max", "no swoosh sounds"). For a single video, just leave notes on it on **Edit**. For a rule every edit should follow, add it to `brand/lessons.md`, or tell the Chief of Staff with the chat button in the bottom-right corner and it saves the rule for you.

More on formats, captions and checks: [Editing](../modules/editing.md).

## Step 4. Film and upload your first takes (about 10 minutes plus filming)

1. Open **Scripts** and open an approved script. Each one has shoot notes, and **Film it** opens the teleprompter. Vertical (9:16), eyes on the lens, quiet room. Say the hook first. Do as many takes as you like in one recording: **the last full take wins**. You can even say edit notes out loud ("editor, cut that").
2. Press **Mark as filmed** when you're done.
3. Open **Edit** and drop your video files (`.mov` or `.mp4`) on it, or drop them anywhere in Studio. Upload as many as you like at once. Big files are fine: uploads resume if the connection drops.
4. Studio listens to the first minute of each take and matches it to its script. A clear match goes straight into the edit. If it isn't sure, Edit shows **Sounds like "…" (74%)**: press **Confirm**, or pick the right script. A take with no script works too: choose **No script, just edit it**.

## Step 5. Watch the edit queue (a few minutes per video)

On **Edit**, **Being edited** shows each take moving through its steps on its own, earliest film-by time first:

**Up next → Cutting → Adding captions → Final checks → Ready for you**

- **Cutting:** a transcript, the pauses and the retakes, then the Art Director writes the edit plan from your format and house style.
- **Adding captions:** captions, cuts, framing and sound.
- **Final checks:** loudness, pauses, frame and captions. A video that fails the check is fixed or flagged, never sent to you as finished.

Each row shows roughly how long is left. If a step stops, the row says why, with **Retry**. Want to approve the cuts before the edit is planned? Open **Settings** at the top of the Edit page and turn on **Review cuts before editing**. It's off by default, so you only review finished videos.

## Step 6. Review, leave notes, approve (as long as you like)

Finished videos wait under **Ready for you** on **Edit**:

1. Watch it.
2. Something to change? Press **Needs changes**, click the timeline to pin a note to that moment ("cut this pause", "zoom in here"), and add general notes ("tighten the hook", "no music"). Press **Send to your editor**. The Art Director makes v2 with your notes and it comes back to **Ready for you**.
3. Happy with it? Press **Looks good**, then **Schedule**, **Download** or **Save as ready**.

If [Level 3](level-3.md) isn't set up yet, use **Download** or **Save as ready**: the video waits under **Ready to post** on **Calendar**, and nothing is posted. The whole loop, step by step: [Your daily workflow](../daily-workflow.md).

### What success looks like

- A finished video you'd post, with every check passing.
- Your notes turned into a v2 within minutes.

---

## Troubleshooting

**An edit stops with a speech error** · The speech model couldn't download. Check your internet, run `./aos doctor --fix` to retry (step 1), then press **Retry** on the row.

**A take didn't match its script** · Pick the script on Edit. Matching uses the first minute of speech, so starting with the hook helps.

**Transcription is slow** · Very long recordings (over 10 minutes) take longer; trim to the takes you want. On a small server, editing is slower than on a recent laptop: 8 GB of memory helps if you edit a lot there.

**Words got clipped** · Pin a note at that moment ("you cut off 'twenty clients'") and send it with **Needs changes**. To make it a rule for every future edit, add it to `brand/lessons.md` in **Brand Kit**, or run `/attention:lesson` in Claude Code.

**Captions sit under the platform buttons** · Your format keeps captions out of the bottom of the frame by default. If you changed `brand/house-style.md`, check the caption position there.

**The motion engine** · Remotion-based motion graphics are opt-in and not part of v0.1. Remotion needs a paid company license for companies with more than three people; AttentionOS shows the [notice](../notices.md) before enabling it.

Next: [Level 3: publish and engage](level-3.md).
