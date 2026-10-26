# AttentionOS docs

AttentionOS is an open-source content operating system for business owners who build a personal brand to grow their business. A team of AI agents researches, plans, scripts, edits, publishes, follows up and learns, and you approve the work.

Start with the setup guide for the level you want. Each level builds on the one before it, and each one is useful on its own.

## Set up

| Level | What you get | Time | Guide |
|---|---|---|---|
| 1 · Install, set up and first scripts | Docker Compose install ([Install](install.md)), Claude token, guided setup in Studio (your website, posts, voice and competitors read for you), the "Film today" brief and your first scripts | 60–90 min, mostly waiting | [Level 1](setup/level-1.md) |
| 2 · Edit | Film, upload, and your takes become finished, captioned videos with quality checks; notes on the timeline for v2 | +20 min | [Level 2](setup/level-2.md) |
| 3 · Publish and engage | Approve a video and it's scheduled; comment keyword → DM → guide; tracked links | +20 min | [Level 3](setup/level-3.md) |
| 4 · Autopilot, your phone and 24/7 | Work on a schedule, Telegram on your phone, a server, backups | +10 min, or about 45 min with a server | [Level 4](setup/level-4.md) |

Then: [Your daily workflow](daily-workflow.md), the film → upload → review → approve loop, step by step.

## Understand it

- [Your daily workflow](daily-workflow.md): film, upload, review, approve, and what happens behind the scenes at each step.
- [Studio](studio.md): every page, settings, signing in from another device and reel mode.
- [Analytics](analytics.md): what Analytics measures and how.
- [Install](install.md): the Docker Compose stack by hand, backups, troubleshooting.
- [AttentionOS on a server](deploy/server.md): running it 24/7, SSH-tunnel access, backups, webhooks.
- [Architecture](architecture.md): how the pieces fit together, and where your files and data live.
- [Sign in to Claude](claude-sign-in.md): exactly what to run to connect AttentionOS to your Claude plan, how to check it, and fixes.
- [How your agents run](copilot-vs-autopilot.md): your own Claude Code (default) or an API key, on request or on Autopilot, and which to pick.
- [Costs](costs.md): what you will pay each month, and how budgets keep spend in check.
- [FAQ](faq.md): short answers to common questions.

## Modules

Each stage of the loop is a module you can turn on or off.

| Module | Agent | Tier | What it does |
|---|---|---|---|
| [onboarding](modules/onboarding.md) | Chief of Staff | Core | Setup in Studio: reads your site and posts, learns your voice, drafts your Brand Kit |
| [research](modules/research.md) | Analyst | Core | Your own posts, competitor outliers, trend radar, teardowns |
| [strategy](modules/strategy.md) | Strategist | Core | Lanes, funnel mix, the daily "Film today" brief |
| [scripting](modules/scripting.md) | Copywriter | Core | Hooks, scripts, claim checks, captions per platform |
| [production](modules/production.md) | Art Director | Default | The daily loop: scripts to film, bulk upload matched to scripts, the edit queue, video review, scheduling |
| [editing](modules/editing.md) | Art Director | Default | Cuts, captions, formats, quality checks, revisions |
| [carousels](modules/carousels.md) | Art Director | Opt-in | Branded carousels with a spend cap |
| [publishing](modules/publishing.md) | Publisher | Default | Scheduling, cross-posting, tracked links |
| [trial-reels](modules/trial-reels.md) | Publisher | Default | A day of Instagram trial reels from one clean reel: varied, checked, scheduled after your OK |
| [community](modules/community.md) | Community | Default | Keyword DMs, lead magnets, DM triage, reply drafts |
| [ops](modules/ops.md) | Chief of Staff | Core | Morning brief, chat, approvals, quiet hours, demo mode |
| [learn](modules/learn.md) | Analyst | Core | What worked, why, and what to make next |
| [knowledge](modules/knowledge.md) | Analyst | Core | A searchable memory of your Brand Kit, posts, scripts and research, on your own machine |

## Providers

AttentionOS talks to outside services through swappable adapters. See the [providers overview](providers/README.md), then the page for each service you use:

[Zernio](providers/zernio.md) · [Blotato](providers/blotato.md) · [Apify](providers/apify.md) · [Instagram Graph API](providers/iggraph.md) · [yt-dlp](providers/ytdlp.md) · [whisper.cpp](providers/whispercpp.md) · [Telegram](providers/telegram.md) · [Discord](providers/discord.md) · [CRM](providers/crm.md)

## Decisions

The reasoning behind the big choices lives in [architecture decision records](adr/README.md).

## Design

The look, motion and voice of every AttentionOS surface is described in the [design system](../design/DESIGN.md).
