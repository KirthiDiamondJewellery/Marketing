# Your daily workflow

Once setup is done, your part of the week is short: **film, upload, review, approve**. Your team does the rest: planning, scripts, editing, captions, scheduling, DMs and measuring what happened.

This page walks through the loop in Studio: what you click, what happens behind the scenes, how feedback works and how scheduling works.

```
 Scripts ──► Edit: upload ──► Being edited ─────────────────► Ready for you ──► Calendar
 you         you              prep → plan → render → check     you               Publisher
                                                       ▲            │
                                                       └── notes ───┘  (v2, v3…)
```

You need [Level 1](setup/level-1.md) for scripts, [Level 2](setup/level-2.md) for edits and [Level 3](setup/level-3.md) for scheduling.

---

## 1. See what to film

The **Strategist** plans each day's filming (the "Film today" brief): a short list of pieces, each with a lane, an angle, a format and a film-by time. It's ready in the morning on weekdays, and it lands under **Needs your OK** on **Home** (and in Telegram, if you've connected it). Press **Looks good**, or say what to swap.

**Home** also shows your day at a glance: scripts needing your OK, scripts ready to film, videos being edited, videos to review, videos ready to post and posts scheduled this week. Click any of them to go straight there.

The **Copywriter** writes a script for each piece in your voice. Every script passes hard checks in code (length, banned phrases, call to action, keyword, and every claim backed by your proof) before you see it. Open **Scripts** to read them. Open a script to **Approve** it, tell the AI what to change (**Rewrite it**), **Edit it yourself** or **Delete** it. For a new one, press **New script**, then **Ask the AI** or **Write it myself**. You can also ask in Claude Code (`./aos claude`, then `/attention:script <the piece's title>`); see [Level 1, step 6](setup/level-1.md#step-6-your-first-brief-and-scripts-about-10-minutes).

## 2. Film

Open **Scripts** and open an approved script. Each one has:

- **Shoot notes**: the format and how to frame it. Vertical (9:16), eyes on the lens, quiet room. Say the hook first.
- **Film it**, which opens the teleprompter. Space plays and pauses, the arrow keys change the speed, + and − change the text size, M mirrors it for a beam-splitter rig, R goes back to the top, Esc closes it.
- **Mark as filmed**, so you can see what's left.

Do as many takes as you like in one recording. **The last full take wins**: restarts and stutters keep your last attempt. You can say edit notes out loud ("editor, cut that") and they're followed.

Batch filming works the same way. On Sundays the Strategist can plan a whole week to film in one session.

## 3. Upload

Open **Edit** and drop your video files (`.mov` or `.mp4`) on it, or drop them anywhere in Studio. Upload as many as you like at once. Big files upload in pieces, so if the connection drops, **Retry** continues where it stopped.

**Behind the scenes:** each take is saved to your workspace (`media/raw/`), a cover frame is grabbed, and the first minute of speech is transcribed and compared with your scripts.

- **A clear match** links the take to its script and starts the edit on its own.
- **A likely match** shows on Edit as **Sounds like "…" (74%)**. Press **Confirm**, or **Pick another script**.
- **No match:** **Pick the script**, or choose **No script, just edit it**.

## 4. Being edited

On **Edit**, **Being edited** shows each take moving through its steps on its own, earliest film-by time first:

| Step | What happens |
|---|---|
| **Up next** | Waiting its turn |
| **Cutting** | A word-level transcript, the pauses and the retakes; a cut list that never clips a word. The Art Director then writes the edit plan from the piece's format, your house style and your lessons |
| **Adding captions** | Cuts, captions, framing, graphics and sound, with loudness set for social |
| **Final checks** | Black frames, freezes, long pauses, clipping, caption size and position. A video that fails is fixed or flagged, never sent to you as finished |

When it's done, the video moves to **Ready for you**. Each row shows roughly how long is left. If a step stops, the row says why; press **Retry**. **Stop** cancels an edit.

**Review cuts before editing** (in **Settings** at the top of the Edit page) stops each take at its cut list so you can approve the cuts first. It's off by default: you only review the finished video, and you can still ask for changes there.

## 5. Review and give feedback

Finished videos wait under **Ready for you** on **Edit**. For each video:

1. **Watch it.**
2. Something to change? Press **Needs changes**.
3. **Pin notes to moments.** Click the timeline where something's off and type what to change ("cut this pause", "zoom in here", "wrong graphic"). Each note keeps its timestamp.
4. **Add general notes** if you like ("tighten the hook", "no music", "end on the close-up").
5. Press **Send to your editor**.

**Behind the scenes:** the Art Director picks up the same edit with your notes and makes the next version. It shows under **Being edited**, then comes back to **Ready for you** marked **Version 2, with your notes**. Repeat as often as you like: v3, v4…. While a new version is being made, nothing about that video goes out.

**From your phone:** every approval has a short reference (like `rf-12`). In Telegram, use the buttons, or reply with the reference and your notes, for example `rf-12 v2 tighten the first two seconds`.

**For good:** a note on one video changes that video. For a rule every future edit should follow, add it to `brand/lessons.md` in **Brand Kit**, or tell the Chief of Staff with the chat button in the bottom-right corner ("never use swoosh sounds") and it saves the rule for you.

## 6. Approve and schedule

Each finished video has a **caption per platform**. Edit any caption in place. Instagram carries the comment keyword; TikTok and YouTube use "DM me WORD" or "link in bio".

Happy with it? Press **Looks good**, then choose what happens next:

- **Schedule**: untick a platform to skip it, then post at the **next open slot on each platform** (the Publisher picks it from your posting plan) or **pick a time**.
- **Download**: save the file.
- **Save as ready**: decide later. It waits under **Ready to post** on **Calendar**.

**Behind the scenes:** scheduling the video also approves its posts. The Publisher checks each post against your connected accounts and each platform's rules before anything is sent, adds a tracked link (`utm_content=<keyword>_<post number>`), and schedules it in Zernio. Each post carries its own key, so nothing is posted twice, even if something is retried. The video moves to **Recently done** on Edit, and its posts show in **Calendar** (week or month, filtered by platform).

**Ready to post**, below the calendar, lists approved videos that aren't scheduled yet: **Schedule**, **Download** or **Mark as posted** if you posted it yourself. A video whose posting failed shows there too, with the reason and **Try again**.

**Instagram feed is "you post it" by default.** Trending audio can only be added in the Instagram app, so about an hour before the slot you get the finished file and caption (in Telegram, if connected) and post it yourself in about 30 seconds. The card shows **You post it**. To let Instagram post on its own, turn on autopost: see [Level 3](setup/level-3.md#step-3-check-your-posting-plan-about-3-minutes).

**Trial reels (optional).** On a finished video under **Recently done** (or a card under **Ready to post**), press **Make trial reels**: give your title, keep or edit the hashtags and caption line, pick the day. AttentionOS makes a day of Instagram trial reels (9 by default), each with its own speed, colour, captions and title, checks every one and shows you the preview. Press **Schedule 9 trial reels** to post them to non-followers through the day; they never appear on your grid. The first time, one goes out right away so you can check it stays off your grid. Clean reels you edited elsewhere can be uploaded with **These are clean reels for trial reels** ticked. More: [Trial reels](modules/trial-reels.md).

When a post goes live, its comment keyword starts sending DMs with your guide ([Level 3](setup/level-3.md#step-4-turn-on-keyword-dms-about-5-minutes)), and its numbers start flowing into **Analytics**.

## 7. See what worked

**Analytics** shows how your posts are doing against your own normal:

| Tab | What's there |
|---|---|
| Overview | Your north star and pace, key numbers against the last period, your best post and why. Links to the **Weekly report** (the week in one page, sent on Mondays) and **Leads and sales** (clicks, leads and sales traced back to the post that brought them) once there's data |
| Your posts | Every post, sortable; open one for its curve against your usual, retention, funnel and post-mortem |
| What's working | Which hooks, formats and lanes lift results, which hold them back, and your best time to post |
| Competitors | How you compare with the creators you watch, and their posts that beat their normal. **Remix this** turns one into a script on Scripts |

Right after setup, Analytics already shows the scan of your own account and your competitors, including your followers.

The Strategist uses the same numbers to plan what you film next. More: [Analytics](analytics.md).

---

## What "approvals off" means

By default, **nothing public goes out until you approve it**. Finished videos always wait for you on Edit, whatever else you change, unless you turn the Art Director to **Full autopilot**.

You set this per agent in **Agents → (agent) → How much it can do on its own**:

| Level | What waits for you |
|---|---|
| **Review everything** (the default) | Every script, edit, post and reply |
| **Review key posts** | Only campaign posts, posts that sell or make claims, and sensitive replies. Finished videos still wait |
| **Full autopilot** | Nothing. The agent acts and tells you afterwards |

With the **Art Director on Full autopilot**, "approvals off" means: each video that passes its checks is approved on its own, the Activity feed says "Approved … on autopilot and sent it to the Publisher", and it's scheduled to the platforms and captions the Publisher planned. The Instagram feed still comes to you as "you post it" unless autopost is on.

With the **Publisher on Full autopilot** but the Art Director on review, you still approve every video; approving it simply doesn't need a separate OK for the posting plan.

The deterministic checks (scripts, captions, keywords, post payloads) run on every level. Autopilot never skips them.

## Related

- [Production module](modules/production.md): the settings and rules behind this loop
- [Editing](modules/editing.md) · [Publishing](modules/publishing.md) · [Community](modules/community.md)
- [Studio](studio.md): every page, settings and reel mode
- [How your agents run](copilot-vs-autopilot.md)
