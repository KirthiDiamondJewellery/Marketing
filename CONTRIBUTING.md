# Contributing to AttentionOS

Thanks for helping. The people who use AttentionOS day to day are business owners, most of them not developers, so clear docs, safe defaults and plain-language messages matter as much as the code.

## Ground rules

1. **No personal or client data, ever.** No real names, business names, handles, emails, phone numbers, chat ids, account ids, tokens or local paths like `/Users/<name>/…`. Examples, fixtures and docs use obvious placeholders only: brand `Examplebrand Studio`, owner `Pat Example`, handles like `@examplebrand.studio` and `@demo_creator_a`, sites and emails on `example.com`, `example.org` or a `*.example` domain.
2. **No third-party media.** No scraped posts, transcripts, screenshots, footage, logos, music or sound effects you don't have the rights to share. Sound effects must be CC0 or synthesized; fonts must be OFL.
3. **Rewrite, never copy.** When porting an idea from another project, re-implement it from a description of the method. Never paste whole files or folders. In the PR, cite where the idea came from and confirm you went through the scrub checklist in the PR template.
4. **No brand literals in engine code or skills.** Skills and prompts reference Brand Kit files by path (`brand/voice.md`), never a brand's actual words.
5. **Code holds the gates.** Validators in `packages/guardrails` are deterministic code. Prompts never replace a check that code can do.
6. **Untrusted text** (scraped posts, DMs, comments, trend items) only goes to tool-less LLM calls whose output is validated.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by` line. It certifies the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or have the right to submit it under the project's MIT license.

```bash
git commit -s -m "Add RSS trend source"
```

This adds `Signed-off-by: Your Name <you@example.com>` using your git config. Forgot it? `git commit --amend -s` for the last commit, or `git rebase --signoff main` for a branch. CI checks every commit in a pull request.

## Development setup

You need:

- **Node 22.18 or newer.** CI tests Node 22 and 24; `.nvmrc` selects 24.
- **pnpm**, through Corepack: `corepack enable` (the version is pinned in `package.json`).
- **Postgres 16+ with pgvector.** The easiest route is Docker: `pnpm db:start` runs `pgvector/pgvector:pg17` on `127.0.0.1:55433` (user and password `postgres`; it's the `DATABASE_URL` in `.env.example`). Any local Postgres with the `vector` extension works too.
- **uv** and Python 3.12 for `media-py/` (only if you work on editing).
- **ffmpeg** for media work.

```bash
corepack enable
pnpm install
cp .env.example .env      # fill in only what you need
pnpm db:start             # local Postgres with pgvector, in Docker
pnpm check                # typecheck + brand-literal guard + tests
```

Useful commands:

| Command | What it does |
|---|---|
| `pnpm typecheck` | TypeScript across every package |
| `pnpm test` | Vitest across the monorepo |
| `pnpm lint` | The brand-literal guard (there's no ESLint or Prettier step) |
| `pnpm attentionos <cmd>` | Run the CLI from source |
| `pnpm plugin:build` | Assemble the Claude Code plugin into `plugin/` |
| `cd media-py && uv run pytest && uv run ruff check .` | Python sidecar checks |

### Adding a dependency

Several people (and agents) often work in this monorepo at once, so installs are serialised:

```bash
scripts/pnpm-locked.sh add zod --filter @attentionos/core
```

Keep dependencies few. Modules never import vendor SDKs; vendor code lives only in `packages/providers/<kind>-<vendor>`.

## Project layout and conventions

The full rules are in [CLAUDE.md](CLAUDE.md). The short version:

- TypeScript strict, ESM. Import local files with explicit `.ts` extensions. Internal packages export `./src/index.ts`, with no build step.
- Zod v4 at every boundary. postgres.js for SQL, and every query filters by `workspace_id`.
- Tests are Vitest files in `test/**/*.test.ts` next to each package. **No network in tests**: providers use recorded fixtures.
- User-facing text is plain language and sentence case, and shows the work, not the wiring ("Drafted 3 scripts for Thursday", never "job 4812 completed").

### Adding a module

`modules/<id>/` with `module.json` (validated by `moduleManifestSchema` in `packages/core/src/module.ts`), `src/index.ts` default-exporting `defineModule({...})`, jobs in `src/jobs/`, MCP tools in `src/tools/` named `<module>_<verb>_<noun>`, skills in `skills/<skill>/SKILL.md`, a `README.md`, tests in `test/`, and a page in `docs/modules/<id>.md`.

### Adding a provider

`packages/providers/<kind>-<vendor>/`, package name `@attentionos/provider-<kind>-<vendor>`, exporting `create(opts)` that returns the matching interface from `packages/core/src/providers.ts`. Map every vendor error to a `ProviderError` with a stable code. `health()` must never spend money. Add contract tests with recorded, scrubbed fixtures and a guide in `docs/providers/`.

### Adding a skill

Skills live in `modules/<id>/skills/<skill>/SKILL.md` and are copied into the plugin by `pnpm plugin:build`. Reference Brand Kit files by path and MCP tools by name. If you adapt MIT-licensed method material, credit it in `NOTICE`. Never vendor third-party skills without a license that allows it.

## The brand-literal guard

`scripts/brand-literal-guard.mjs` runs in CI and in `pnpm lint`. It fails on local user paths, real-looking email addresses, phone numbers, and anything on a deny-list.

The public deny-list `scripts/brand-literals.deny` holds only generic patterns. Maintainers keep a private deny-list (real names and brands that must never land here) outside the repo and point the guard at it:

```bash
ATTENTIONOS_DENYLIST=/path/to/private.deny node scripts/brand-literal-guard.mjs
```

If the guard flags something legitimate, change the example to use placeholders rather than weakening the guard.

## How changes get merged

- **Nobody pushes to `main` directly**, maintainers included. Every change, however small, arrives as a pull request.
- **Fork the repo**, create a branch in your fork (`fix/telegram-retry`, `feat/rss-source`), and open a PR against `main`.
- **Only the maintainer can approve and merge.** [`.github/CODEOWNERS`](.github/CODEOWNERS) makes the maintainer the required reviewer for every file. Approvals from anyone else don't count toward merging.
- **CI must be green**: typecheck, the brand-literal guard, tests, media-py checks, gitleaks and the DCO sign-off check.
- New commits after an approval need a fresh review. Force-pushing to `main` and deleting it are blocked.
- The project moves quickly, so rebase on `main` before asking for review, and expect the maintainer to ask for changes or to close PRs that don't fit the roadmap. Opening an issue first for anything bigger than a fix saves everyone time.

## Pull requests

- Keep PRs focused. One module, provider or fix per PR is ideal.
- Fill in the PR template, including the scrub checklist.
- Add or update tests and docs.
- Add a changeset for user-visible changes: `pnpm changeset`.
- `pnpm check` must pass. CI also runs gitleaks and the DCO check.

## Reporting bugs and requesting features

Open an issue at [github.com/evanbaker315/AttentionOS/issues](https://github.com/evanbaker315/AttentionOS/issues/new/choose) and pick a form: **bug report**, **feature request** or **provider request**. Include the output of `./aos doctor` (or `attentionos doctor`) and what you expected to happen. Search existing issues first. Questions and ideas that aren't bugs go to [Discussions](https://github.com/evanbaker315/AttentionOS/discussions).

For security issues, **don't open an issue**; follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
