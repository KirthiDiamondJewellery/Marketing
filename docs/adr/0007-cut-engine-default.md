# ADR-7: Cut engine by default, Remotion opt-in, one EditPlan schema

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

Most reels for business owners are talking heads with captions, light graphics and clean cuts. Agents that drive an editor directly can spend very large numbers of tokens per clip. Motion graphics are valuable for some formats, but Remotion requires a paid company license for companies with more than three people.

## Decision

- One **EditPlan** schema (source and time map, format, layout segments, captions, overlays, b-roll, audio, camera, export).
- The model writes the plan; rendering is deterministic.
- **Cut engine** (Python, ffmpeg, PIL, OpenCV) is the default renderer.
- **Motion engine** (Remotion) is opt-in and requires acknowledging the license (`acknowledgements.remotionLicense`).

## Consequences

- Target of under $0.50 of model spend per reel is reachable.
- Plans are inspectable and revisable; approved segments stay byte-stable across revisions.
- Two renderers must honor the same schema; features may land in one first.

## Alternatives considered

- **Agent-driven editing in a GUI or timeline API.** Too expensive and non-deterministic.
- **Remotion only.** Licensing friction for many users, and heavier to install.
