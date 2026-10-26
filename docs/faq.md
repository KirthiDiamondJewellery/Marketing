# FAQ

## The basics

**What is AttentionOS?**
An open-source content operating system for business owners who build a personal brand to grow their business. A team of AI agents researches what works in your niche, plans what to film, writes scripts in your voice, edits your footage, publishes, follows up on comments and DMs, measures results and learns from them. You approve the work.

**Who is it for?**
Mainly agency owners, coaches, consultants, local service owners and founders who have expertise and proof but little time. Content creators and educators can use it too, with lanes weighted towards audience growth.

**Do I need to code?**
No, but setup needs a terminal and Docker. You copy a set of commands to install and start AttentionOS, and sign in to Claude. After that, daily use happens in Studio, in your browser: setup, scripts, edits, approvals and the calendar. The [Level 1 guide](setup/level-1.md) takes about 60–90 minutes, most of it waiting.

**Is it really free?**
The software is free and MIT-licensed. You pay for the services you connect, typically about $20–$120 a month in total. See [costs](costs.md).

## Your content and your voice

**Will it sound like me?**
Your voice profile is built from **your** transcripts during setup, not from a template. Every correction you make becomes a written rule in `brand/lessons.md`, so it gets closer every week.

**Will it copy other creators?**
No. AttentionOS studies the **structure** of what works (hook patterns, pacing, formats) and remixes it. Hooks are never reused word for word, every script records where its hook came from, and teardowns include a "what's theirs, don't copy" section.

**Will it make up numbers?**
No. Numbers in proof content can only come from your `brand/proof-inventory.yaml` or a cited source. Every claim goes through a claim ledger marked PASS, FIX or CUT.

**Will it post without asking me?**
Not unless you tell it to. Every agent starts at `review_all`: everything waits for your approval. You can relax that per agent later.

**Will it name my clients?**
Only with consent recorded in your proof inventory.

## Running it

**Do I need an Anthropic API key?**
No. Your agents run on your own Claude Code, signed in with your Claude account, on the plan you already pay for. That includes the background worker. An API key is optional: use it (`runner: { engine: "api" }`) if you'd rather pay per use. See [How your agents run](copilot-vs-autopilot.md).

**What's the difference between "On request" (Copilot) and Autopilot?**
Both run on your own Claude Code. On request, agents do AI work only when you ask: in Studio chat, with **Run now**, from approvals, Telegram or Claude Code. On Autopilot, they also work on a schedule, like overnight research and the morning brief. Data jobs with no AI (syncs, scoring) run on schedule in both.

**Does my computer need to stay on?**
Not if you only use AttentionOS inside Claude Code. For Studio chat, Run now and Autopilot, AttentionOS must be running (`./aos start`), so keep the computer awake or use a small VPS ([guide](deploy/server.md)).

**How do I sign in to Claude Code on a server with no browser?**
On your own computer, run `claude setup-token` and give the server the token it prints as `CLAUDE_CODE_OAUTH_TOKEN`. Or sign in over SSH with `claude auth login`. Step by step: [Sign in to Claude Code on the server](deploy/server.md#sign-in-to-claude).

**Which operating systems work?**
macOS, Linux and Windows (with WSL or Docker). Platform-specific speed-ups are optional, never required.

**Where is my data?**
Your Brand Kit is plain files in your workspace folder. Posts, metrics, queues and the knowledge store your agents search are in a Postgres database on your own machine (or your own server). The model that makes the knowledge store searchable by meaning also runs on your machine. Media stays on your machine unless you choose cloud storage. Nothing is sent to the AttentionOS maintainers.

**Can I manage several brands?**
The database supports several workspaces from day one. Each brand gets its own workspace folder. A multi-brand dashboard comes later.

## Platforms and services

**Why Zernio by default and not Blotato?**
Zernio is free for your first two accounts, has richer webhooks for the learning loop, includes LinkedIn analytics, and is cheaper for the typical 4–6-account owner. Blotato is a fully supported alternative. See [costs](costs.md#publishing-zernio-vs-blotato).

**Why does Instagram feed posting default to "assist"?**
Trending audio can't be added through any API. In assist mode you get the finished file and caption at the right time and post it yourself in about 30 seconds. Autopost is one setting away.

**Is scraping competitors allowed?**
Reading public posts through a third-party service may conflict with a platform's terms. AttentionOS shows a notice and asks you to acknowledge it once, only reads accounts you list, never logs in as you and never automates a browser. You can use the official Instagram Graph API instead.

**Can I use Discord instead of Telegram?**
Yes. See [Discord](providers/discord.md).

## Costs and safety

**How do I stop it spending too much?**
On the default engine, AI work is part of your Claude plan, so there's no per-run bill; every run still has a turn limit and a timeout. Budgets in your config cover the rest: per month for scraping and per day for images, plus per run and per day for AI if you use the API engine. Scraping spend is checked **before** each scan. When a budget is reached, work stops and you get an alert.

**What if a DM tries to trick the agents?**
DMs, comments and scraped posts are untrusted. They only go to model calls with no tools, and the output is checked by a validator before anything uses it.

**Is AttentionOS made by Anthropic?**
No. AttentionOS is an independent open-source project, Powered by Claude.

## Getting help

**Something isn't working.**
Run `./aos doctor`. It checks every key, tool and connection and gives a plain-language fix for each failure.

**How do I report a bug or ask for a feature?**
Open an issue on GitHub using the bug or feature template. For security problems, use a private security advisory instead; see `SECURITY.md`.

**Can I contribute?**
Yes, please. Read `CONTRIBUTING.md` first. Every contribution needs a DCO sign-off, and no personal or client data may ever be committed.
