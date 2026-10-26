# Studio

Studio is AttentionOS's dashboard: what needs you today, your scripts, your edits, your calendar, a live map of what each agent is doing, analytics, the Brand Kit and settings. It reads and writes the same database as Claude Code, Telegram and the worker, so an approval in one place shows up everywhere.

Studio runs on your own computer or server, in the same Docker install as the worker and the database. Nothing is hosted for you and nothing is published to the internet.

---

## Open it

Studio comes with the Docker stack (see [Install](install.md)). It runs in Docker together with the worker and the database, and starts by itself:

- **Installed on this computer:** open **http://localhost:4747** (`./aos open` from your AttentionOS folder). There's no sign-in: Studio is published to `127.0.0.1` only, so nothing else on your network can reach it.
- **On a server:** Studio is on the server's `127.0.0.1:4747`; open it through an SSH tunnel (`ssh -L 4747:127.0.0.1:4747 root@<server>`, then http://localhost:4747). See [AttentionOS on a server](deploy/server.md).

The first time, Studio opens on setup (`/setup`): your website and handles, your keys, competitors, then your team drafts your Brand Kit for you to approve, and you go live. Studio then opens **Agents**, so you can watch your team start. See [Onboarding](modules/onboarding.md). After that, the daily loop is [Scripts, Edit and Calendar](daily-workflow.md).

| Task | Command (from your AttentionOS folder) |
|---|---|
| Open Studio | `./aos open` |
| Is it running? | `./aos status` |
| Restart (after editing settings files) | `./aos restart` |
| Watch the logs | `./aos logs` |
| Use another port | `AOS_PORT=4748` in `.env`, then `./aos restart` |

The worker in the same container does the AI work you start from Studio (chat, **Run now**, approvals), whichever mode you're in. It runs your agents on Claude Code, signed in with your own Claude account, on your Claude plan; no API key needed. Set `CLAUDE_CODE_OAUTH_TOKEN` at install ([Install](install.md) step 4) or run `./aos claude-login`. More: [How your agents run](copilot-vs-autopilot.md).

### Without Docker (developers)

From a checkout of this repository, or a workspace with the `attentionos` package, the CLI runs Studio directly:

```bash
pnpm attentionos studio      # Studio on http://localhost:4747, this computer only (add --worker for the worker)
pnpm attentionos up          # Studio + the worker, on your Tailscale address when Tailscale is running
```

| Option | What it does |
|---|---|
| `--port 4748` | Use another port (the default is 4747) |
| `--open` | Open Studio in your browser |
| `--worker` | (`studio`) Also run the worker in the same terminal, so chat and **Run now** work |
| `--host <address>` | Listen somewhere other than this computer. Anything but `127.0.0.1` turns on sign-in (see below) |
| `--allow-public` | Allow `0.0.0.0` or a public address. Only behind a firewall or a reverse proxy you control. The Docker image uses it inside the container, where Compose publishes the port to `127.0.0.1` only |

`up` listens on this machine's Tailscale address when Tailscale is running, else on `127.0.0.1`. It refuses `0.0.0.0` and public addresses unless you pass `--allow-public`, and even then it requires the access key (or an explicit mode below). Worker options work there too: `--no-webhooks`, `--webhook-port 8787`, `--concurrency 2`.

## Pages

| Page | What's there |
|---|---|
| **Home** | Your day at a glance: scripts needing your OK, ready to film, being edited, videos to review, ready to post and scheduled this week. Below: **Needs your OK** for other approvals (like the daily brief), **Going out next** and your latest results |
| **Scripts** | Scripts the AI wrote for you. **New script** → **Ask the AI** or **Write it myself**. Open a script to approve it, tell the AI what to change, edit it yourself or delete it, film it with the teleprompter, and mark it as filmed |
| **Edit** | Drop your footage here, as many files as you like. Takes are matched to their scripts on their own. **Being edited** shows the progress; **Ready for you** is where you watch each video and press **Needs changes** (notes pinned to moments make a new version) or **Looks good** (then **Schedule**, **Download** or **Save as ready**). **Recently done** below. **Settings** at the top has **Review cuts before editing** |
| **Calendar** | Scheduled posts by week or month, with a filter per platform. Below it, **Ready to post**: approved videos that aren't scheduled yet (**Schedule**, **Download**, **Mark as posted**), and any that failed to post, with **Try again** |
| **Agents** | **Worker view**: a room where each agent lights up while it works. **Command view**: an orbit view of the whole team. **Full screen** for filming. Your team is listed below; open an agent to see its work and set how much it can do on its own |
| **Analytics** | Overview, Your posts, What's working and Competitors. Your setup scan of your own account and your competitors shows straight away, including followers. **Remix this** on a competitor's post turns it into a script on Scripts |
| **Brand Kit** | Your business, voice, lanes, house style and lessons, to read and edit |
| **Settings** | How your workspace runs (see below) |

The **Chief of Staff** is the chat button in the bottom-right corner of every page. Old addresses (Film, Edits, Approvals, Command view, Research, Insights, Content) still work and open the page that holds that work now.

## Signing in

`ATTENTIONOS_STUDIO_AUTH` sets how Studio checks who's visiting. The Docker stack sets `local`; `AOS_STUDIO_AUTH` in the stack's `.env` overrides it:

| Mode | Who gets in | Where it's used | Only allowed when |
|---|---|---|---|
| `local` | Everyone who can reach it, no sign-in | The local Docker setup | Studio listens on `127.0.0.1`, or in the Docker container whose port is published to `127.0.0.1` only |
| `tailscale` | Your tailnet's people by their Tailscale login (from `tailscale serve`); anyone else with the access key | Behind `tailscale serve` | Studio listens on `127.0.0.1` behind `tailscale serve`, so the only way in is through Tailscale |
| `token` | Anyone with the access key | Your choice, anywhere | Always |
| *(not set)* | No sign-in on `127.0.0.1`; the access key anywhere else | `pnpm attentionos studio` / `up` | |

Studio refuses to start when a mode doesn't fit where it listens (for example `local` on a network address), and says how to fix it.

**The access key.** In the Docker setup it's `ATTENTIONOS_STUDIO_TOKEN` in the stack's `.env` (`./aos access-key` prints it). Without Docker, the first `attentionos up` creates one, saves it in the workspace `.env` and prints it once.

- Paste the key on the sign-in page, and that browser stays signed in for 30 days (an httpOnly cookie signed with the key).
- To sign every device out, replace `ATTENTIONOS_STUDIO_TOKEN` with a new random value (at least 24 characters) and restart.
- Sign-in attempts are rate-limited.
- `/api/health` stays open for health checks. It reports the workspace name, whether the worker is online and the version, and never any secrets.

**Tailscale identity.** In `tailscale` mode, set `ATTENTIONOS_STUDIO_TAILSCALE_USERS` to a comma-separated list of logins to let only those people in without the key. Running from source behind `tailscale serve`:

```bash
# workspace .env
ATTENTIONOS_STUDIO_AUTH=tailscale
ATTENTIONOS_STUDIO_TAILSCALE_USERS=you@example.com     # optional: only these logins
```

```bash
pnpm attentionos up --host 127.0.0.1
tailscale serve --bg 4747
```

(The older `ATTENTIONOS_STUDIO_AUTH=token` plus `ATTENTIONOS_STUDIO_TRUST_TAILSCALE=1` still works and means the same.)

## Settings

**Settings** in the sidebar shows how your workspace runs, and lets you change the simple parts without opening a code editor:

| Section | What you can do |
|---|---|
| Workspace | Brand name, timezone, and how your agents run: **On request** (AI work only when you ask) or **Autopilot** (also on a schedule). AI work runs on your own Claude Code login; to use an API key instead, set `runner: { engine: "api" }` in your config |
| Modules | Switch modules on and off by setup level; accept the [notices](notices.md) some features need |
| Services | See which service does each job and whether its key is set |
| Budgets | Daily AI and per-task limits (API engine), monthly research and daily image limits |
| Connections and keys | See which keys are set or missing (never their values) and add a key to `.env` |
| Checkup | Run the same checks as `./aos doctor`, with plain fixes, plus whether the worker is online |
| Access | Where Studio is listening and how to open it from your phone |

Settings live in `config/attentionos.config.ts`, a file you own. Studio changes one value at a time, checks the edited file loads and validates before saving it, and leaves your comments and formatting alone. If a value is set by code (a variable or a spread), Studio says so and asks you to edit the file instead. Restart Studio and the worker after saving so every part picks up the change.

## Reel mode

Reel mode turns Studio into a clean recording surface for content about your system: no cursor, no notifications, smooth 60 fps motion, and demo mode to mask names if you want no real data on camera.

| Key | What it does |
|---|---|
| Shift+R | Reel mode on or off |
| 1–8 | Play one of the eight showcase moments |
| [ and ] | Slower or faster: 100%, 75% or 50% speed |
| V | Vertical 9:16 framing, keeping the action inside the safe area |

The moments and the design rules behind them are in the [design system](../design/DESIGN.md#64-reel-mode).

## Troubleshooting

**Studio doesn't load** · Run `./aos status`. Right after installing or updating, the first start takes a few minutes; `./aos logs` shows what it's doing. If Docker isn't running, open OrbStack or Docker Desktop.

**"Port 4747 is already in use"** · Set `AOS_PORT=4748` in the `.env` of your AttentionOS folder and run `./aos restart` (without Docker: `--port 4748`).

**"Studio needs an access key"** · Studio listens beyond this computer without a key. In Docker, check `ATTENTIONOS_STUDIO_TOKEN` in the stack's `.env`; without Docker, run `attentionos up` once to create one, or set it in the workspace `.env`.

**The page says the worker is offline** · `./aos restart`. Without Docker: `pnpm attentionos up` (Studio and the worker) or `pnpm attentionos worker`.

**A run fails with "Claude Code isn't signed in"** · Run `./aos claude-login`, then check with `./aos doctor`. Without Docker, on the machine running the worker: `claude auth status`, and sign in with `claude`.

**Studio shows old settings after I edited the file** · Studio reads the settings when it starts. `./aos restart`.

**Anything else** · `./aos doctor`, or `./aos logs` for the details.
