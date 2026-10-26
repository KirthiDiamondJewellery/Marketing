# Level 4: Autopilot, your phone and 24/7

**Time:** about 10 minutes to turn on Autopilot and Telegram; about 45 minutes more to move to a server, most of it waiting · **Cost:** included in your Claude plan by default; a small server is about $10–20 a month

Level 4 lets your team work while you don't: research runs overnight, the morning brief is ready when you wake up, metrics sync on their own, edits keep moving and DMs are sorted as they arrive. You approve from your phone. Nothing goes public beyond the approvals you choose.

Everything here is already in the install: the worker runs next to Studio in the same container. You only switch things on.

---

## Before you start

| You need | Why | Cost |
|---|---|---|
| Levels 1–3 working | Autopilot runs the same work on a schedule | — |
| Claude signed in ([how](../claude-sign-in.md)) | Background work runs on your own Claude plan | Your Claude plan |
| A machine that stays on, **or** a small server | The worker only works while AttentionOS is running | $0, or about $10–20 a month |
| *Optional:* a Telegram account | Your brief, approvals and chat on your phone | Free |

---

## Step 1. Turn on Autopilot (1 minute)

You may have done this on the **Go live** step. To check or change it: **Settings → Workspace**, and pick **Autopilot**.

| | **On request** | **Autopilot** |
|---|---|---|
| When AI work runs | When you ask: Studio chat, **Run now**, approvals, Claude Code, Telegram | Also on a schedule: overnight research, the morning brief, DM triage |
| Good for | Getting started; keeping your plan's usage low | Hands-off days |

Your edits move through the queue either way: uploading a take starts its edit. Every run has a turn limit and a timeout. Runs on your Claude plan aren't billed per run; Studio shows how many steps each one used. More: [How your agents run](../copilot-vs-autopilot.md).

Prefer pay-per-use billing to your Claude plan? Set `runner: { engine: "api" }` in `config/attentionos.config.ts`, add `ANTHROPIC_API_KEY` in **Settings → Connections and keys**, and set daily limits in **Settings → Budgets**.

## Step 2. Choose how much each agent does on its own (about 5 minutes)

Open **Agents**, pick an agent from your team below the room, and under **How much it can do on its own** choose:

| Level | Meaning |
|---|---|
| **Review everything** | Every draft waits for you. The right start. |
| **Review key posts** | Only campaign posts and sensitive replies wait. |
| **Full autopilot** | Acts on its own and tells you afterwards. |

Finished videos always wait for you on **Edit**, unless the **Art Director** is on **Full autopilot**: then each video that passes its checks is approved and scheduled on its own, and you're told afterwards. Most owners keep the Art Director and the Publisher on **Review everything**. What "approvals off" means in practice: [Your daily workflow](../daily-workflow.md#what-approvals-off-means).

## Step 3. Telegram on your phone (about 5 minutes)

1. In Telegram, message **@BotFather** and send `/newbot`. Pick a name; BotFather replies with a token.
2. In Studio, paste the token into the **Telegram** card (on the **Go live** step, `/setup?step=go-live`, or as `TELEGRAM_BOT_TOKEN` in **Settings → Connections and keys**).
3. Open your new bot in Telegram and press **Start**, then press **Check** in Studio, and **Send a test message**.

Now your morning brief, approvals with buttons, "time to post" reminders and alerts arrive in Telegram. Reply to the bot to talk to your Chief of Staff, or send notes on a video by its reference (for example `rf-12 v2 tighten the hook`). Only your own chat is accepted, so nobody else can instruct your agents. Details: [Telegram](../providers/telegram.md). Prefer Discord? See [Discord](../providers/discord.md).

## Step 4. Run it 24/7 on a server (about 45 minutes)

Autopilot only works while AttentionOS is running. On a laptop that sleeps, schedules wait until it wakes. For hands-off days, run the stack on a small VPS:

1. Rent a small Ubuntu server (2 CPUs, 4 GB of memory, 40 GB of disk; 8 GB of memory if you edit a lot there) with your SSH key.
2. On the server, follow [Install](../install.md) steps 1–5 with `AOS=/opt/attentionos`. Mint the Claude token on your laptop (`claude setup-token`) and paste it into the server's `.env`, or run `./aos claude-login` there.
3. Reach Studio through an SSH tunnel: `ssh -N -L 4747:127.0.0.1:4747 root@<server>`, then open http://localhost:4747. On your phone, Telegram (step 3) covers the brief, approvals and notes.

Full guide: [AttentionOS on a server](../deploy/server.md).

**Moving from your computer?** Copy your Brand Kit and settings to the server's workspace (`/opt/attentionos/workspace`) and, if you want your history too, restore your latest database backup there. Both are in [the server guide](../deploy/server.md#backups).

## Step 5. Instant updates (optional)

Without webhooks everything works; post numbers and DMs arrive on the next scheduled sync. With them, Zernio tells AttentionOS the moment a post publishes or a DM arrives. That needs a public HTTPS route to the worker's `/webhooks/` receiver, which the default stack doesn't expose: see [Webhooks](../deploy/server.md#webhooks).

## Step 6. Backups (2 minutes to check)

`./aos backup` writes a database dump and a copy of your workspace into `backups/` in the stack dir and keeps the last 14 days. It isn't scheduled by default: add the cron job (Linux) or launchd job (macOS) from [Install → Backups](../install.md#backups). To back up right now:

```bash
cd ~/AttentionOS && ./aos backup          # Linux or a server: cd /opt/attentionos
```

Footage in `workspace/media` isn't included (it's large); keep your own copy of what matters. Now and then, copy the `backups/` folder somewhere else, such as another computer or cloud storage. On a server: `scp -r root@<server>:/opt/attentionos/backups ./attentionos-backups`. How to restore: [Backups](../deploy/server.md#backups).

### Level 4 checklist

| Check | Where | Good looks like |
|---|---|---|
| Studio and the worker | `./aos status` | `Studio: healthy · worker online` |
| Claude | `./aos doctor` or **Settings → Checkup** | Claude Code is signed in |
| Mode | **Settings → Workspace** | Autopilot |
| Autonomy | **Agents** | Each agent at the level you chose |
| Telegram | **Send a test message** | It arrives on your phone |
| Backups | `ls backups` in your AttentionOS folder | Today's or last night's files |

---

## Troubleshooting

**Autopilot stops when my laptop sleeps** · Set your computer to stay awake while plugged in, or move to a server (step 4). On a Mac, set OrbStack or Docker Desktop to open at login so AttentionOS starts by itself.

**"Claude isn't signed in", or runs fail straight away** · From your AttentionOS folder run `./aos claude-login`. On a server without a browser it walks you through signing in from your phone. See [Sign in to Claude](../claude-sign-in.md).

**I'm hitting my Claude plan's usage limits** · Switch back to **On request** for a while, turn off schedules you don't need, or move to the API engine (step 1). Agents pick the work back up when your limit resets.

**A job ran twice** · Jobs are claimed from a queue one at a time, and posts carry their own keys, so a post can't go out twice. If you see two runs, one was likely a manual rerun.

**I want to pause everything** · Switch to **On request** to stop scheduled AI work, or `./aos stop` to stop AttentionOS completely (`./aos start` brings it back). Anything already waiting for your OK stays waiting.

**Anything else** · `./aos doctor`, the [FAQ](../faq.md), and [Studio](../studio.md).
