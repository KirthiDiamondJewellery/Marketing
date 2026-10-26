# ADR-11: workspace_id and RLS from day one; single-workspace UI until later

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Maintainers

## Context

Agencies will run several brands, and Studio will let more than one person sign in. Adding tenancy to a schema later is expensive and error-prone.

## Decision

- Every table carries `workspace_id`, and every query filters by it.
- Row-level security policies keyed on `workspace_members` protect access through the Supabase API and Studio.
- The engine connects as the database owner for its own jobs.
- The UI and CLI stay single-workspace until multi-brand support is built.

## Consequences

- Multi-brand support later is a UI change, not a migration.
- Slightly more verbose queries and tests from the start.

## Alternatives considered

- **One database per brand.** Simple isolation, but heavy to operate for agencies.
- **Add tenancy later.** Cheaper today, much costlier later.
