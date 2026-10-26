# ADR-4: TypeScript core with a Python media sidecar

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

The engine needs a CLI, an MCP server, a worker, scoring and provider adapters, all of which fit the Node ecosystem and the Agent SDK. Video work (speech-to-text, silence detection, rendering, face framing, loudness, QC) is far better served by Python libraries and ffmpeg tooling.

## Decision

- A **TypeScript monorepo** (pnpm workspaces, Turborepo, strict TypeScript, Node 22.18+) for everything except media.
- A **Python 3.12 sidecar, `media-py`**, managed with `uv`, exposing a CLI with **JSON in and JSON out**. The TypeScript side calls it as a subprocess.

## Consequences

- Each media step is testable on its own (pytest plus ruff), and the boundary is a simple, versionable JSON schema.
- Users need `uv` for Level 2; `attentionos doctor --fix` installs it.
- Two toolchains to maintain in CI.

## Alternatives considered

- **All TypeScript.** Weaker media libraries; more reinvention.
- **All Python.** Loses the Agent SDK, MCP and Node CLI ecosystem the rest of the product relies on.
- **A long-running Python service.** More moving parts than a JSON CLI for v0.1.
