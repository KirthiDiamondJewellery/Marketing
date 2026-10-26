# Install

AttentionOS runs as a Docker Compose stack: `postgres` (pgvector/pg17) and the `attentionos` app container (Studio + the Autopilot worker + media tools + Claude Code). This guide builds that stack by hand.

Supported hosts: macOS (Apple silicon or Intel) and Linux (Debian/Ubuntu tested). Windows: WSL 2 (Ubuntu) with Docker Desktop, following the Linux steps inside WSL. Read [Windows (WSL 2)](#windows-wsl-2) first.

## Requirements

| | |
|---|---|
| Docker | Engine 24+ with the Compose v2 plugin. macOS: [OrbStack](https://orbstack.dev) or Docker Desktop. Linux: [Docker Engine](https://docs.docker.com/engine/install/) |
| Resources | 4 GB RAM minimum (8 GB recommended on a laptop), ~10 GB free disk for the image, models and caches |
| git, curl, openssl | For fetching the source, `./aos update` and generating secrets |
| Claude | A Claude Pro or Max plan, and [Claude Code](https://code.claude.com) on a machine with a browser to mint a long-lived token (`claude setup-token`). Alternatively the API engine with `ANTHROPIC_API_KEY` |

## Layout

Everything lives in one directory, the **stack dir**. Conventionally `~/AttentionOS` on macOS and `/opt/attentionos` on Linux. The commands below use `$AOS`:

```
$AOS/
├─ .env                 stack config + secrets (chmod 600)
├─ docker-compose.yml   copied from src/deploy/
├─ aos                  ops helper, copied from src/deploy/
├─ uninstall.sh         copied from src/deploy/
├─ src/                 the AttentionOS source; the image is built from here
├─ workspace/           your workspace (Brand Kit, config, lessons, media), bind-mounted at /workspace
└─ backups/             pg_dump + workspace tarballs
```

## 1. Docker

**macOS:** install OrbStack (`brew install orbstack`) or Docker Desktop, start it, and set it to launch at login. The stack has `restart: unless-stopped`, so it comes back whenever Docker does.

**Linux:**

```bash
# Docker Engine + compose plugin from Docker's apt repo: https://docs.docker.com/engine/install/ubuntu/
sudo apt-get install -y git curl openssl
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # optional; log out and back in. Otherwise prefix docker commands with sudo
```

Check: `docker compose version` prints v2.x.

## 2. Source and stack dir

```bash
export AOS=~/AttentionOS            # Linux: /opt/attentionos (then sudo mkdir -p $AOS && sudo chown $USER $AOS)
mkdir -p "$AOS"/{workspace,backups}
chmod 700 "$AOS/backups"
git clone --depth 1 https://github.com/evanbaker315/AttentionOS "$AOS/src"

cd "$AOS"
cp src/deploy/docker-compose.yml docker-compose.yml
cp src/deploy/aos aos && cp src/deploy/uninstall.sh uninstall.sh
chmod 755 aos uninstall.sh
```

**Linux only:** the container runs as uid 1000 and must be able to write the workspace:

```bash
sudo chown -R 1000:1000 "$AOS/workspace"
```

## 3. `.env`

```bash
cd "$AOS"
cp src/deploy/.env.example .env
chmod 600 .env
```

Then set these keys. Everything else in the file has a working default.

| Key | Value |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 20`. **Set once.** Postgres initialises its volume with it; changing it later locks the app out of the database |
| `ATTENTIONOS_STUDIO_TOKEN` | `openssl rand -hex 24`. Studio's access key (≥ 24 chars) |
| `AOS_SRC_DIR` | `./src`. The example's default (`..`) only applies when running compose from inside the repo |
| `AOS_STACK_DIR` | The absolute path of `$AOS`. Used to write the workspace's `.mcp.json` so host Claude Code can reach the MCP server |
| `TZ` | IANA zone, e.g. `readlink /etc/localtime \| sed 's#.*/zoneinfo/##'` |
| `PRESET` | `coach-consultant` or `agency-founder`. Seeds a new workspace on first start |
| `BRAND_NAME` | Seeds a new workspace; editable later in Studio |
| `CLAUDE_CODE_OAUTH_TOKEN` | See step 4. Leave empty to set it after the first start |

`docker compose` refuses to start without `POSTGRES_PASSWORD` and `ATTENTIONOS_STUDIO_TOKEN`.

## 4. Claude token

The agents run `claude -p` inside the container, authenticated with a long-lived OAuth token (`sk-ant-oat01-…`). Mint it on a machine with a browser:

```bash
claude setup-token        # or: src/deploy/claude-token.sh (installs Claude Code if missing)
```

Put the result in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=…`. On a headless server, skip this and run `./aos claude-login` after step 5: it runs `setup-token` inside the container and prints a URL to approve from any device.

To use the API instead of a Claude plan, set `runner: { engine: "api" }` in the workspace config and `ANTHROPIC_API_KEY` in the workspace `.env`. See [docs/copilot-vs-autopilot.md](copilot-vs-autopilot.md).

## 5. Build and start

```bash
cd "$AOS"
docker compose build --pull attentionos       # first build: 5–15 min
docker compose up -d --remove-orphans --wait --wait-timeout 900
```

On every start the entrypoint (`deploy/docker-entrypoint.sh`) waits for Postgres, creates the workspace from `PRESET`/`BRAND_NAME` if `/workspace` is empty, applies migrations (`attentionos db push`) and execs `attentionos up`. On first start it also pulls the speech, face and embedding models (~500 MB) into the `attentionos-data` volume in the background.

Verify:

```bash
curl -fsS http://127.0.0.1:4747/api/health    # {"ok":true,...}
./aos status
./aos doctor                                    # attentionos doctor inside the container
```

Studio: <http://localhost:4747>. It opens on onboarding.

If `--wait` times out, `./aos logs` (or `docker compose logs --tail 100 attentionos`) shows why. The usual causes are a wrong `AOS_SRC_DIR`, an unwritable workspace (Linux uid), or the build running out of disk.

## Backups

`./aos backup` runs `src/deploy/backup.sh`: a `pg_dump -Fc` of the database plus a tarball of the workspace (excluding `media/` unless `AOS_BACKUP_MEDIA=1`) into `backups/`, pruning after `AOS_BACKUP_KEEP_DAYS` (default 14). Nothing schedules it for you.

**Linux (cron):** keep the trailing tag, since `./uninstall.sh` uses it to remove the job.

```cron
17 3 * * * cd /opt/attentionos && ./aos backup >> backups/backup.log 2>&1 # AttentionOS backup (/opt/attentionos)
```

**macOS (launchd):** write `~/Library/LaunchAgents/ai.attentionos.backup.attentionos.plist` (the label must match `ai.attentionos.backup.<AOS_PROJECT>` for `./uninstall.sh` to find it):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.attentionos.backup.attentionos</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>/Users/YOU/AttentionOS/aos</string><string>backup</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>/Users/YOU/AttentionOS/backups/backup.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/AttentionOS/backups/backup.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.attentionos.backup.attentionos.plist
```

Restore: [docs/deploy/server.md#backups](deploy/server.md#backups).

## Windows (WSL 2)

The stack runs in Docker Desktop's WSL 2 backend. Every command in this guide runs in the **Ubuntu (WSL) terminal**, not PowerShell or Git Bash: `aos`, `backup.sh` and `uninstall.sh` are bash scripts. Native Windows without WSL isn't supported.

**Setup**

1. In an admin PowerShell: `wsl --install -d Ubuntu`. Reboot if asked, open Ubuntu and create your user.
2. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the WSL 2 backend. Turn on **Settings > Resources > WSL integration** for Ubuntu, and **Start Docker Desktop when you sign in**.
3. In Ubuntu: `sudo apt-get update && sudo apt-get install -y git curl openssl`. Check `docker compose version` works. If it doesn't, the WSL integration is off.
4. Follow steps 2–5 with `AOS=~/AttentionOS`. Skip step 1 (Docker Desktop provides it) and the `chown` (your WSL user is uid 1000, the same as the container's; check with `id -u`, and if it isn't 1000, run the `chown` from step 2).

**Rules that matter**

- **Keep the stack dir in the Linux home** (`~/AttentionOS`), never under `/mnt/c/...`. On the Windows drive, builds and file access are many times slower, and `chmod 600 .env` silently does nothing, so your secrets file isn't private. `./aos` warns if it detects this.
- **Clone inside WSL** with WSL's `git`. If you clone or unzip on the Windows side and copy the files in, shell scripts may arrive with CRLF line endings. The repo's `.gitattributes` and the image build guard against this. If `./aos` fails with `$'\r': command not found`, fix the helpers with `sed -i 's/\r$//' aos uninstall.sh src/deploy/*.sh`.
- **Memory.** WSL 2 gets about half of the PC's RAM by default. On a 16 GB PC that's enough; on 8 GB, create `C:\Users\<you>\.wslconfig` with:

  ```ini
  [wsl2]
  memory=6GB
  ```

  then `wsl --shutdown` in PowerShell and restart Docker Desktop.

**Differences from Linux**

| | On WSL |
|---|---|
| Studio | `http://localhost:4747` in your Windows browser. Docker Desktop forwards the port. `./aos open` uses `wslview` if installed, else `explorer.exe` |
| Claude token | Mint it with `claude setup-token` wherever Claude Code is installed (Windows or WSL) and paste it into `.env`, or run `./aos claude-login`. That signs in from inside the container and prints a link to open in your Windows browser |
| Claude Code on the host | Run it **inside WSL** (`cd ~/AttentionOS/workspace && claude`). The workspace's `.mcp.json` calls `docker compose exec` with Linux paths, so Claude Code running natively on Windows can't reach your data. Or use `./aos claude` |
| Backups | WSL doesn't run cron by default, and the Ubuntu distro stops when idle, though the containers keep running in Docker Desktop. Schedule backups with **Windows Task Scheduler** instead (below) |
| Autopilot 24/7 | Works while the PC is awake and Docker Desktop is running. For hands-off days, use a [server](deploy/server.md) |

**Nightly backup with Task Scheduler.** In PowerShell (replace `Ubuntu` if your distro has another name):

```powershell
$action  = New-ScheduledTaskAction -Execute "wsl.exe" -Argument '-d Ubuntu -- bash -lc "cd ~/AttentionOS && ./aos backup >> backups/backup.log 2>&1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 3:17am
Register-ScheduledTask -TaskName "AttentionOS backup" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
```

Remove it with `Unregister-ScheduledTask -TaskName "AttentionOS backup"` (`./uninstall.sh` doesn't see Windows tasks).

## Remote server

Same steps over SSH on the server. Notes:

- 2 vCPU / 4 GB is enough. Ubuntu 24.04 LTS is the tested target.
- Mint the Claude token on your laptop and paste it into the server's `.env`, or use `./aos claude-login` on the server.
- Studio is bound to the server's loopback. Reach it with `ssh -L 4747:127.0.0.1:4747 user@host`.
- Full walkthrough: [docs/deploy/server.md](deploy/server.md).

## Claude Code on the host

With `AOS_STACK_DIR` set, the entrypoint writes `workspace/.mcp.json` pointing at `docker compose exec` into the stack, so:

```bash
cd "$AOS/workspace" && claude
```

gets the AttentionOS MCP tools against the live database. The workspace's `.claude/settings.json` enables the `attentionos` plugin from the GitHub marketplace. No host Claude Code? Use `./aos claude`.

## Operating

| | |
|---|---|
| `./aos status` / `logs [svc]` / `doctor` | Health, logs, diagnostics |
| `./aos start` / `stop` / `restart` | Lifecycle |
| `./aos update` | Re-clone `src/` from `AOS_REPO_URL`@`AOS_REPO_BRANCH`, refresh `docker-compose.yml`, `aos`, `uninstall.sh`, rebuild, restart. Migrations run on start |
| `./aos backup` | Run a backup now |
| `./aos access-key` | Print `ATTENTIONOS_STUDIO_TOKEN` |
| `./aos cli <args>` | Any `attentionos` command inside the container (e.g. `./aos cli status`) |
| `./aos shell` / `./aos claude` | Shell or Claude Code inside the app container |
| `./aos uninstall [--purge]` | Remove containers, image and the backup job. `--purge` also offers to delete the volume, workspace and stack dir |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `required variable POSTGRES_PASSWORD is missing` | `.env` isn't in the directory you ran compose from, or the key is empty |
| `$'\r': command not found` or `/bin/sh^M` (Windows) | CRLF line endings from a Windows-side checkout: see [Windows (WSL 2)](#windows-wsl-2) |
| Build fails with `unable to prepare context` | `AOS_SRC_DIR` doesn't point at the checkout; use `./src` |
| `EACCES` on `/workspace` (Linux) | `sudo chown -R 1000:1000 $AOS/workspace` |
| `password authentication failed for user "attentionos"` | `POSTGRES_PASSWORD` changed after the volume was initialised. Restore the original value, or (destroys data) `docker compose down -v` |
| `bind: address already in use` on 4747 | Set `AOS_PORT` in `.env`, then `./aos restart` |
| Agents don't run / "Claude isn't signed in" | `CLAUDE_CODE_OAUTH_TOKEN` empty or expired: `./aos claude-login`. More: [docs/claude-sign-in.md](claude-sign-in.md) |
| Build killed / no space left | Free ~10 GB, `docker builder prune`, rebuild |
