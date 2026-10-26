# Unfinished Studio features

These components are kept for a later release. Nothing in Studio imports them, so they can't be reached in the UI,
but they're still typechecked with the rest of Studio (`pnpm exec tsc --noEmit -p tsconfig.json`), so they keep
compiling against today's queries and actions. Each file starts with an `// Unfinished feature:` comment that points here.

Wire one in by importing it from a page, then remove its header comment and its row below.

| File | What it's for |
| --- | --- |
| `film/film-view.tsx` | The Film page: what to shoot, a teleprompter per script, and uploaded takes matched to their scripts. |
| `stream/agent-stream.tsx` | The live agent stream side panel (who's working, what needs you, what the team did) and its collapsed rail. |
| `edits/edit-queue.tsx` | The edit queue: every video in the pipeline, in film-by order, with editing progress and the next action. |
| `insights/whats-working.tsx` | What's working: which choices beat your typical post, with likely ranges and thin samples called out. |
| `home/film-today.tsx` | Home's "film today" brief: what to shoot today, with the format and shoot directions. |
| `home/waiting-list.tsx` | Home's short list of approvals waiting on you, each with one-click approve. |
| `home/team-panel.tsx` | Home's "Your team" panel: the compact live agent map with a one-line read of what the team is doing. |
| `home/today-strip.tsx` | Home's loop strip: Film, Upload, Editing, Review and Scheduled at a glance, each linking to its page. |
| `chat/chat-drawer.tsx` | A quick-open drawer for chatting with the Chief of Staff from anywhere in the shell. |
| `charts/fluid-line.tsx` | A single-series line chart drawn at its real width, with an optional dashed goal line. |
| `approvals/revising-list.tsx` | Videos sent back with notes, shown as "Editing v2…" until the new version arrives. |
| `approvals/decided-list.tsx` | Recently decided approvals, newest first: the paper trail of what you signed off. |
| `upload/upload-button.tsx` | An "Upload takes" button: pick many videos at once and each is matched to its script. |
| `command/CommandView.tsx` | The standalone full-screen command view. The Command tab on Agents (`agents/command-board.tsx`) replaced it. |
| `command/AgentMap.tsx` | The compact agent map. Only the unfinished Home team panel uses it. |
| `command/index.ts` | The barrel export for the command view. Nothing imports it; Agents imports `Orbit` directly. |

`command/Orbit.tsx` and `command/AgentCard.tsx` are in use (by the Command tab on Agents) and aren't on this list.

## Server code kept for these features

- `server/queries/film.ts` `getFilmData`: data for the Film page.
- `server/queries/production.ts` `getTodayStrip`: counts for the Home loop strip.
- `server/queries/approvals.ts` `getRevisingVideos`: the videos being revised.

Not used by anything yet (no page or unfinished component calls them): `getPostDetail` and `getCompetitors` in
`server/queries/insights.ts`, `getTeardowns` and `getResearchSummary` in `server/queries/research.ts`, and
`unreadyAction` in `server/actions/approvals.ts`.
