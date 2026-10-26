# Workspace template: notes for the `attentionos create` author

This folder is copied as-is into a new workspace by `attentionos create <dir> --preset <id>` (the Docker stack runs it on first start). Do not copy this `TEMPLATE.md` file itself.

## Placeholders

Substitute these in every text file before writing (a plain string replace is enough):

| Placeholder | Value | Files |
|---|---|---|
| `{{WORKSPACE_NAME}}` | Brand name from the prompt or the directory name | `brand/brand.yaml`, `config/attentionos.config.ts`, `CLAUDE.md`, `README.md` |
| `{{WORKSPACE_SLUG}}` | npm-safe lowercase slug of the name | `package.json` |
| `{{PRESET}}` | Preset id, e.g. `coach-consultant` | `config/attentionos.config.ts` |
| `{{TIMEZONE}}` | IANA zone, default from `Intl.DateTimeFormat().resolvedOptions().timeZone` | `brand/brand.yaml`, `config/attentionos.config.ts` |
| `{{WORKSPACE_ID}}` | A new random UUID (v4) | `config/attentionos.config.ts` |

## Presets overlay the Brand Kit

After copying, overlay `presets/<id>/` on top:

- `presets/<id>/pillars.md` replaces `brand/pillars.md`.
- `presets/<id>/sources.yaml` replaces `brand/sources.yaml`.
- `cadence.yaml`, `cta.yaml` and `formats.md` are reference files: copy them to `brand/knowledge/preset-<file>` (strategy and publishing read them from there), or read them from the installed preset.
- `preset.json` holds metadata (funnel mix, north star). Apply `funnelMix` to `brand/brand.yaml` and `northStar` to the config if they differ from the template defaults.

## Dotfiles

Real dotfiles ship in this template: `.gitignore`, `.env.example`, `.mcp.json`, `.claude/settings.json`. There is no `_gitignore` renaming. If you publish the CLI to npm, note that npm strips `.gitignore` from packages: include the template in the CLI bundle under a path npm keeps, or rename at pack time and back at copy time.

## Created at copy time (not in this folder)

- `media/raw/`, `media/renders/`, `media/assets/` (gitignored, so they can't ship as files).
- `.attentionos/` for local state.
- `.env`, only if the user provides values during setup; otherwise point them at `.env.example`.

## Config import

`config/attentionos.config.ts` imports `defineConfig` from `attentionos/config`. The workspace `package.json` depends on `attentionos`, and the CLI loader must resolve that import even before `npm install` has run.
