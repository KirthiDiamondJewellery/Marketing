# Changesets

Every pull request with a user-visible change adds a changeset: `pnpm changeset`, pick the packages it touches and the kind of change (patch, minor, major), and write one plain-language line about what changed for the user.

Nothing here is published to npm (every package is private). Changesets only bumps versions and writes the changelog entries when the maintainer cuts a release (`pnpm changeset version`).
