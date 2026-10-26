# ADR-6: Engine and workspace split

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

Users must be able to personalize everything without editing engine code, and upgrade without merge conflicts. Forking an engine repo per brand makes upgrades painful and invites personal data into shared code.

## Decision

- This repository is the **engine**: TypeScript packages, the Claude Code plugin, `media-py` and the Docker stack. It runs from a clone of the repository; nothing is published to npm.
- Each user's **workspace**, created by `attentionos create` (the stack runs it on first start), holds their Brand Kit, config, lessons and media, and runs on the engine version of the stack it's mounted in.
- The workspace config imports its helper as `import { defineConfig } from "attentionos/config"`, which the engine resolves itself.
- Upgrades are `./aos update` (new engine source, rebuilt image), never a merge into the workspace.

## Consequences

- Clean upgrades and no brand data in the engine.
- The engine must expose stable extension points: Brand Kit schemas, module settings, presets.
- Breaking changes to the Brand Kit or config need migrations and clear release notes.

## Alternatives considered

- **Fork per brand.** Simple at first, painful forever after.
- **Hosted service.** Out of scope for an open-source, local-first v0.1.
