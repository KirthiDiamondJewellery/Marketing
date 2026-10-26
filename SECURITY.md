# Security policy

AttentionOS handles API keys, social accounts, private messages and leads for real businesses. We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub security advisories:

**[Report a vulnerability](https://github.com/evanbaker315/AttentionOS/security/advisories/new)**

Include what you found, how to reproduce it, the affected version or commit, and the impact you expect. A proof of concept helps but isn't required. Please never include real secrets or anyone's personal data in a report.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | within 3 business days |
| First assessment (severity, scope) | within 7 days |
| Fix or mitigation for high and critical issues | within 30 days, sooner where possible |
| Public advisory | after a fix is released, crediting you unless you prefer otherwise |

There is no bug bounty. We're glad to credit reporters in the advisory and the changelog.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (latest) | Yes |
| Older pre-releases | No; please upgrade with `./aos update` |

## In scope

- **Secrets in workspaces:** anything that could leak values from a workspace `.env`, logs, error messages, notifications or the database.
- **The MCP data server and its tools:** bypassing approvals, acting outside the workspace, writing without actor attribution, or crossing `workspace_id` boundaries.
- **Prompt injection through untrusted text:** scraped posts, transcripts, comments, DMs or trend items that make an agent take actions, call tools, publish, send messages or reveal data.
- **Guardrails:** ways to get unvalidated scripts, captions, payloads or DMs past the deterministic validators.
- **Webhooks and chat:** signature verification, replayed or forged webhooks, and Telegram or Discord messages from someone other than the workspace owner being accepted as commands.
- **Row-level security** policies in the database schema.
- **Supply chain:** the Docker image build, the project's dependencies, the Claude Code plugin and its hooks.

## Out of scope

- Vulnerabilities in third-party services (Zernio, Blotato, Apify, Telegram, Discord, Anthropic). Please report those to the vendor.
- Issues that need an already-compromised machine or a malicious workspace owner.
- Missing hardening headers on local-only development servers.

## Keeping your workspace safe

- Keep `.env` out of git (the workspace `.gitignore` already does this).
- Use scoped, revocable API keys where the provider offers them.
- Leave agents on `review_all` until you trust their output.
- Keep AttentionOS up to date with `./aos update`.
- Headless agents use a bounded MCP reader for workspace content; native filesystem and shell tools are disabled. Keep credentials in `.env`, never in Brand Kit, script, caption or media text files.
- Deploy for one trusted owner. Provider adapters and installed modules run trusted application code; the content-reader policy is not an operating-system sandbox for plugins.
