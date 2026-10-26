# Onboarding

The Chief of Staff's setup in Studio. You give your website and your handles; your team reads your site, pulls your own posts, transcribes your best videos, studies your competitors and drafts your first Brand Kit while you watch. About fifteen minutes of your time, and you never paste a post.

| | |
|---|---|
| Agent | Chief of Staff (`Cs`), with the Analyst, the Copywriter and the Art Director doing the work |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) |
| Needs | Claude signed in. An [Apify](../providers/apify.md) token (recommended) or a [Zernio](../providers/zernio.md) key to read your posts. The speech-to-text model to learn your voice from your videos (otherwise from your captions) |
| Brand Kit files it writes | `brand/brand.yaml`, `brand/offers.md`, `brand/icp.md`, `brand/voice.md`, `brand/pillars.md`, `brand/competitors.yaml`, `brand/proof-inventory.yaml` |

## Where it is

Studio opens setup at **`/setup`** on first run, and keeps sending you there until you finish or skip it. Setup remembers where you were: close the tab and come back any time. The step rail at the top lets you jump to any step, and `/setup?step=<step>` opens one directly (for example `/setup?step=keys`).

## The steps

### 1. Welcome

Your team wakes up, and three checks say whether everything they need is running: the database, Claude (signed in, on your plan) and the worker. A check that fails shows the exact command to fix it, usually `./aos claude-login`. You can keep going; steps that need AI wait until it's fixed.

### 2. You

Your website and the accounts you post on (Instagram, TikTok, YouTube, LinkedIn, X; at least one). A handle or a profile link both work. When you continue, the **Analyst starts reading your website** in the background.

### 3. Keys

Two optional keys that let the team work without you copying anything:

- **Apify** reads public posts: yours (views, captions and the video files your voice is learned from) and your competitors' (to find their outliers).
- **Zernio** brings back your real analytics and, later, publishes your posts and runs comment-to-DM.

Each card shows where to find the key. **Save and check** tests it straight away. For Zernio, Studio lists the accounts it can see and **matches them to your handles**: *Connected as @yourname*, *Zernio has @other, not @yourname*, *Needs reconnecting inside Zernio* or *Not connected yet*, each with what to do, and **Refresh** after you fix it in Zernio. Keys are saved in your workspace's private `.env` file, never shown again.

### 4. Competitors

Three to ten creators per platform who make the kind of posts you want to make. Type or paste handles, one platform tab at a time. **Suggest some** has the Analyst search the web for creators in your niche; click a suggestion to add it (hover to see why it was suggested). Your own handles and duplicates are refused, with a reason.

If you read posts through Apify, the **scraping notice** sits right here: reading public posts through a third-party service may conflict with a platform's terms. Tick **I understand, read public posts for me** to allow the scan. Without it, the scan waits and your own posts come from Zernio only. The full notice: [Notices](../notices.md).

### 5. Start

The page lists what happens when you press **Start**, then shows it live, one line per job:

| Line | Who | What happens |
|---|---|---|
| Your posts | Analyst | Pulls your recent posts and their numbers (Apify: with the video files; Zernio only: captions and numbers) |
| Transcripts | Art Director | Transcribes your best 15 videos and the top competitor outliers, on your own machine |
| Your voice | Copywriter | Starts by itself once your transcripts are in, and drafts your voice profile |
| Competitors | Analyst | Scans the creators you picked and finds their outliers |
| Your website | Analyst | Finishes reading your site and drafts your offers and ideal customer |
| Search index | Analyst | Indexes everything so every agent can search it ([Knowledge](knowledge.md)) |

It takes a few minutes. You can continue while it runs; drafts appear in Review as soon as they're ready. Each line says plainly when something didn't work and why (for example *Waiting for the scraping notice* or *this month's scraping budget is used up*). Pressing Start also switches on editing, which the transcripts need.

### 6. Review

Your team's drafts, side by side. Edit anything, then **Approve all** (or approve a card at a time):

- **Your business**, drafted by the Analyst from your website: what you do in one sentence, your offers (with price and how people start: book a call, buy online, send a message, comment a keyword…) and your ideal customer.
- **Your voice**, drafted by the Copywriter from your own transcripts and captions: how you sound in one line, how you talk, your signature moves, phrases in your words and what you never say. If it's still waiting for transcripts, you can draft it now from what's already there.
- **Content lanes**, from your preset: each lane, its funnel stage and how many posts a week. Switch preset or move the sliders.

Approved cards become your Brand Kit, which every agent reads before it writes. You can come back to Review from **Brand Kit** any time.

### Optional: proof and stories

**Add proof and stories** (from Review, or `/setup?step=interview`) is a live interview with the Chief of Staff, about ten minutes. It asks for results you can prove, client stories, the objections you hear and how customers describe their problem. Short answers are fine and you can stop any time. Numbers are only kept when you say where they come from. **Save to Brand Kit** adds them to `brand/proof-inventory.yaml` (the only place agents take numbers from) and `brand/icp.md`.

### 7. Go live

The last choices, all changeable later:

- **What waits for your OK:** **Review everything** (every script, edit, post and reply) or **Review key posts only** (routine work goes ahead; posts that sell, make claims or reply to people wait). This sets every agent; fine-tune each one later in **Agents**.
- **Autopilot:** overnight research, the morning brief and follow-ups run on a schedule, on your Claude plan, while the machine running AttentionOS is on. Off means agents work when you ask.
- **Telegram (optional):** your brief, approve and reject buttons, and alerts on your phone. Paste a token from @BotFather, press **Start** in your bot, then **Check** and **Send a test message**.

A summary shows what's done, with **Edit** or **Finish** next to each part. Press **Go live**: the Strategist plans today's filming and the Analyst checks your trend sources, and Studio opens **Agents** (`/agents`), where you watch your team start.

## What's next

Your first brief and scripts: [Level 1, step 6](../setup/level-1.md#step-6-your-first-brief-and-scripts-about-10-minutes). Then the loop: [Your daily workflow](../daily-workflow.md).

## Approvals

Nothing in setup goes public. Brand Kit drafts are saved only when you approve them.

## Limits

- Private or region-locked accounts can't be read.
- Without Apify there are no video files, so transcripts and competitor scans wait; your voice is drafted from captions.
- Without the speech-to-text model, transcripts are skipped and your voice is drafted from captions. Download it with `./aos doctor --fix` ([Level 2](../setup/level-2.md#step-1-check-the-speech-model-is-ready-1-minute)).
- Platforms your scraper can't scan are saved for the Strategist but not scanned.
