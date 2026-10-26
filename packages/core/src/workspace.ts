import type { AttentionOSConfig } from "./config.ts";
import type { BrandKit } from "./brand.ts";
import type { Sql } from "./db.ts";
import type { Logger } from "./log.ts";
import type { ProviderRegistry } from "./providers.ts";

/** Paths inside a user's workspace (created by `attentionos create`, which the Docker stack runs on first start). */
export type WorkspacePaths = {
  root: string;
  brand: string;
  config: string; // config/attentionos.config.ts
  media: string; // media/ (gitignored): raw/, renders/, assets/
  lessons: string; // brand/lessons.md
  state: string; // .attentionos/ (local caches, tokens; gitignored)
};

/** Everything a job, tool or skill helper needs. Built once per process by `@attentionos/runtime`-style loaders in the CLI/worker. */
export type WorkspaceContext = {
  /** `workspaces.id` in Postgres. Every row carries it. */
  id: string;
  paths: WorkspacePaths;
  config: AttentionOSConfig;
  /** Lazily loaded and cached; call `reloadBrand()` after edits. */
  brand(): BrandKit;
  reloadBrand(): BrandKit;
  sql: Sql;
  providers: ProviderRegistry;
  log: Logger;
  /** Injectable clock for tests. */
  now(): Date;
  /** Secrets from the workspace `.env` (never logged). */
  secret(name: string): string | undefined;
};
