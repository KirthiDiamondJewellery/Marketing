# {{WORKSPACE_NAME}}: AttentionOS workspace

This folder is where your content system lives. It holds what makes your brand yours (your voice, your audience, your offers, your proof) and the settings for your AI team. AttentionOS itself is installed separately and updates without touching anything here.

## What's in this folder

| Path | What it is |
|---|---|
| `brand/` | Your Brand Kit. Plain text files you can read and edit. Start here. |
| `config/attentionos.config.ts` | Settings: which modules are on, which services to use, budgets, how much each agent can do alone |
| `media/` | Your footage and finished videos (`raw/`, `renders/`, `assets/`). Private and not backed up by git |
| `.env` | Your keys and tokens. Private. Copy `.env.example` to create it |
| `CLAUDE.md` | Instructions Claude follows when it works in this folder |

## First steps

1. **Check your setup.** Run `./aos doctor` from your AttentionOS folder. It lists what's ready and how to fix what isn't.
2. **Follow setup in Studio** (`./aos open` from your AttentionOS folder; about 15 minutes of your time). Give it your website and your handles; your team reads your site, pulls your own posts, transcribes your best videos, studies your competitors and drafts your first Brand Kit, including a voice profile built from how you actually talk. You approve it before anything is used. You never paste a post. (Prefer Claude Code? Open this folder in it and run `/attention:init`.)
3. **Read your Brand Kit.** Open the files in `brand/` (or **Brand Kit** in Studio) and fix anything that isn't quite right. Look for lines marked `TODO`.
4. **Get your first brief.** Studio's **Home** shows what to film today; in Claude Code, `/attention:brief`.

## A normal day

- **Morning:** the brief is ready in Studio (and on Telegram once it's set up). It tells you what to film, what's waiting for your approval, and how yesterday's posts did.
- **Approve or reject:** in Studio, with the buttons in Telegram, or `/attention:approvals` in Claude Code. Nothing goes public until you say yes.
- **Film:** record the pieces from the brief and drop the files on Studio's **Edit** page. Your takes are matched to their scripts and edited for you to review.
- **Correct freely:** when something is off, say so. Every correction becomes a rule in `brand/lessons.md`, so you only say it once.

## Setup levels

You don't need everything on day one.

| Level | What you get | Extra time |
|---|---|---|
| 1 · Research and scripts | Install, Brand Kit, competitor research, trends, daily brief, scripts | 60–90 min, mostly waiting |
| 2 · Edit | Raw footage to finished reel | +20 min |
| 3 · Publish and engage | Scheduling, comment-to-DM, tracked links | +20 min |
| 4 · Autopilot | Work on a schedule, Telegram on your phone, optionally a server | +10 min, or about 45 min with a server |

## Getting help

- `./aos doctor` explains problems in plain language.
- The AttentionOS docs cover each setup level step by step, every module, costs and a FAQ.
- Questions and bug reports go to the AttentionOS GitHub repository. Never share your `.env` file or private client details when asking for help.
