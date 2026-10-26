# ADR-8: MIT license and a new repository

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

AttentionOS wants broad adoption, including commercial use. The public repository must never contain personal data, client data, third-party media or unlicensed material.

## Decision

- License the project under **MIT**.
- Start a **fresh repository** with no imported history. All code is written new for this project.
- Adapted MIT-licensed method files are credited in `NOTICE`. Third-party skills without a license are not vendored.

## Consequences

- No risk of leaking data through old commits.
- Maximum freedom for users and contributors.
- More work up front, since nothing is carried over.
- CI enforces hygiene with gitleaks and a brand-literal guard; contributors sign off under the DCO.

## Alternatives considered

- **Apache-2.0.** Patent grant is attractive, but MIT is simpler for the target audience and contributors.
- **Importing existing code or history.** Unacceptable data and licensing risk.
