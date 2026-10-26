# ADR-12: Autopilot runs locally by default; Docker for a VPS; webhooks through a tunnel

- **Status:** Accepted (updated: the Docker image shipped in v0.1 and is now the standard way to run, see below)
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

Owners want background work without managing servers. Their footage and media tools already live on their own machine. Some will prefer an always-on server.

## Decision

- The worker runs **on the user's machine** by default (`attentionos worker`).
- A **Docker image** supports running on a VPS.
- Incoming webhooks reach a home machine through a **tunnel**; signatures are verified.

## Consequences

- No hosting cost by default, and media stays local.
- Work pauses while the machine sleeps; the docs explain power settings and the VPS path.
- Tunnel setup is an extra step for webhook users; polling remains a fallback.

## Update: Docker everywhere

The Docker image (`deploy/Dockerfile`, with `deploy/docker-compose.yml` and the `./aos` helper) shipped in v0.1, earlier than planned. It's now the standard way to run AttentionOS on a laptop as well as on a server, so "local by default" means the Docker stack on the user's own machine rather than `attentionos worker` started by hand. Running from source stays available for development. See [docs/install.md](../install.md) and [docs/deploy/server.md](../deploy/server.md).

## Alternatives considered

- **Hosted worker.** Contradicts local-first, open-source v0.1 scope.
- **VPS only.** Adds cost and complexity for every user.
