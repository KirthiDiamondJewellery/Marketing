# AttentionOS on a server

Run the stack on a VPS so Autopilot keeps working while your laptop sleeps. It's the same Docker Compose stack as [Install](../install.md), with `AOS=/opt/attentionos`. Studio stays bound to the server's loopback; you reach it over an SSH tunnel. On your phone, use the Telegram or Discord bot.

```
 laptop ──ssh -L 4747──► server (Docker)
                          ├─ attentionos   Studio :4747 (127.0.0.1) + worker ──► Claude Code (your plan)
                          └─ postgres      internal network only
 phone ──Telegram/Discord bot (outbound from the worker)
```

## Provision

- Ubuntu 24.04 LTS (Debian 12 also works), 2 vCPU, 4 GB RAM (8 GB if you edit a lot of video there), 40 GB disk
- SSH key auth. Firewall: allow 22/tcp only. Nothing else needs to be open
- `apt install unattended-upgrades` for host security patches

## Install

On the server, follow [Install](../install.md) steps 1–5 with `AOS=/opt/attentionos`. Server-specific notes:

- Linux needs `sudo chown -R 1000:1000 /opt/attentionos/workspace`, because the container runs as uid 1000.
- `sudo systemctl enable --now docker`. With `restart: unless-stopped`, the stack comes back after a reboot.
- Claude token: see [Sign in to Claude](#sign-in-to-claude).
- Add the backup cron line from [Install → Backups](../install.md#backups).

## Access

```bash
ssh -N -L 4747:127.0.0.1:4747 root@<server>     # then open http://localhost:4747
```

Studio runs in `local` auth mode (no sign-in), which is only safe because the port is published to the server's `127.0.0.1`. If you put your own reverse proxy in front of it (Caddy, nginx, Cloudflare Tunnel…), set `AOS_STUDIO_AUTH=token` in `.env` and `./aos restart`. Studio then requires the access key (`./aos access-key`). TLS, rate limiting and anything else at the edge are up to you. Auth modes: [docs/studio.md#signing-in](../studio.md#signing-in).

## Operations

From `/opt/attentionos`:

| | |
|---|---|
| `./aos status` | Containers, Studio/worker health |
| `./aos logs [svc]` | Follow logs |
| `./aos update` | Re-clone source, rebuild, restart (migrations on start) |
| `./aos backup` | Backup now |
| `./aos doctor` | Diagnostics |
| `./aos claude` | Claude Code inside the container, in the workspace |

| What | Where |
|---|---|
| Workspace | `/opt/attentionos/workspace` (uid 1000) |
| Stack config + secrets | `/opt/attentionos/.env` (0600) |
| Database | Volume `attentionos_postgres-data`, internal network only |
| Models and caches | Volume `attentionos_attentionos-data` |
| Source the image is built from | `/opt/attentionos/src` |
| Backups | `/opt/attentionos/backups` |

Moving a workspace from your laptop: `scp -r brand config root@<server>:/opt/attentionos/workspace/`, then `chown -R 1000:1000` it. Or keep the workspace in a private git repo and clone it there.

### Backups

`./aos backup` writes `backups/db-<stamp>.dump` (`pg_dump -Fc`) and `backups/workspace-<stamp>.tar.gz` (without `media/` unless `AOS_BACKUP_MEDIA=1`), keeping 14 days. Schedule it with cron ([Install → Backups](../install.md#backups)). Copy backups off the box: `scp -r root@<server>:/opt/attentionos/backups ./attentionos-backups`.

Restore:

```bash
cd /opt/attentionos
docker compose exec -T postgres pg_restore -U attentionos -d attentionos --clean --if-exists < backups/db-<stamp>.dump
tar -xzf backups/workspace-<stamp>.tar.gz -C workspace
./aos restart
```

### Webhooks

Providers such as Zernio can push events (post published, new DM) to the worker's receiver on container port `8787` under `/webhooks/`. The default stack doesn't expose that port. Without webhooks everything still works, and events arrive on the next scheduled sync. To use them, route a public HTTPS path to `/webhooks/` only (never Studio), for example a `docker-compose.override.yml` that publishes `127.0.0.1:8787:8787` behind your reverse proxy. Signatures are verified on receipt.

## Sign in to Claude

Agents run on Claude Code with your own Claude account. The long-lived OAuth token goes in `/opt/attentionos/.env` as `CLAUDE_CODE_OAUTH_TOKEN` and is read at container start, never baked into the image.

- **From your laptop:** `claude setup-token`, copy the `sk-ant-oat01-…` token into the server's `.env`, then `./aos restart`.
- **From the server:** `./aos claude-login`. It runs `setup-token` in the container, prints a URL you approve on any device, and saves the token.

Check: `./aos claude auth status` should report `"loggedIn": true`, and `./aos claude -p "Say hello"` should get a reply. Treat the token like a password. If it leaks, mint a new one and revoke sessions in your Claude account. Metered billing instead: `runner: { engine: "api" }` in the workspace config and `ANTHROPIC_API_KEY` in the workspace `.env`. Full guide: [docs/claude-sign-in.md](../claude-sign-in.md).

## Security notes

- The only listener on the host is Studio on `127.0.0.1:4747`. Postgres isn't published at all.
- `local` auth (no sign-in) relies on that loopback binding. Any proxy that makes Studio reachable from another device needs `AOS_STUDIO_AUTH=token`.
- Keep `/opt/attentionos/.env` and the workspace `.env` at 0600. They hold the DB password, the Studio access key and your Claude token.

## Uninstall

```bash
cd /opt/attentionos && ./aos uninstall          # keeps workspace, backups and the database volume
./aos uninstall --purge                          # also offers to delete them, one by one
```
