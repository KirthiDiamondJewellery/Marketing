## What this changes

<!-- One or two sentences. Link the issue if there is one: "Closes #123". -->

## Why

## How it was tested

<!-- Tests added or updated, and anything you checked by hand (e.g. `./aos doctor`, or a flow in Studio). -->

## Scrub checklist

AttentionOS must never contain personal or client data. Please confirm every item:

- [ ] No personal or client data: no real names, business or brand names, handles, emails, phone numbers, chat or account ids.
- [ ] Examples, fixtures and docs use only obvious placeholders (`Examplebrand Studio`, `@demo_creator_a`, `*.example` domains).
- [ ] No local paths like `/Users/<name>/…` or `C:\Users\<name>\…`.
- [ ] No secrets, tokens or `.env` files (gitleaks passes).
- [ ] No third-party media (posts, transcripts, screenshots, footage, logos, music, sound effects) without a license that allows it.
- [ ] Ported code was rewritten, not copied. Source of the idea (if any): <!-- path or link -->
- [ ] No brand literals in engine code, prompts or skills (they reference Brand Kit files by path).

## Quality checklist

- [ ] Every commit is signed off (`git commit -s`).
- [ ] Tests added or updated; no network calls in tests (recorded fixtures only).
- [ ] Docs updated (module, provider or setup pages, README if needed).
- [ ] User-facing text is plain language and sentence case.
- [ ] A changeset is included for user-visible changes (`pnpm changeset`).
- [ ] `pnpm check` passes locally.
