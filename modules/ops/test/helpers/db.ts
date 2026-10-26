import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseConfig,
  silentLogger,
  type AttentionOSConfigInput,
  type InboundMessage,
  type Notifier,
  type OutboundMessage,
  type Sql,
  type WorkspaceContext,
} from "@attentionos/core";
import { createTestDatabase as createDb, hasTestDatabase } from "@attentionos/db/testing";

/**
 * Test database for this module only: `attentionos_test_ops` on the test server (ATTENTIONOS_TEST_DATABASE_URL,
 * default the `pnpm db:start` Postgres). It is dropped and recreated per run, migrated by the real migration runner.
 */
const DB_NAME = "attentionos_test_ops";
const OPS_MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Workspace roots made by makeWorkspace, removed when the database is dropped. */
const tempRoots: string[] = [];

/** True when Postgres is reachable; prints why not (and throws under CI) otherwise. */
export function databaseAvailable(): Promise<boolean> {
  return hasTestDatabase();
}

export async function createTestDatabase(): Promise<{ sql: Sql; drop(): Promise<void> }> {
  const moduleDirs = existsSync(OPS_MIGRATIONS) ? [{ dir: OPS_MIGRATIONS, source: "ops" }] : [];
  const db = await createDb(DB_NAME, { moduleDirs });
  return {
    sql: db.sql,
    async drop() {
      await db.drop();
      for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A notifier that records sends and replays scripted inbound messages. */
export function fakeNotifier(id = "telegram") {
  const sent: OutboundMessage[] = [];
  let inbox: InboundMessage[] = [];
  let failNext: Error | undefined;
  const n: Notifier & { sent: OutboundMessage[]; push(...m: InboundMessage[]): void; failOnce(e: Error): void } = {
    id,
    sent,
    async health() {
      return { ok: true, detail: "fake" };
    },
    async send(msg) {
      if (failNext) {
        const e = failNext;
        failNext = undefined;
        throw e;
      }
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
    async receive(cursor) {
      const out = inbox;
      inbox = [];
      return { messages: out, cursor: String(Number(cursor ?? 0) + out.length) };
    },
    push(...m) {
      inbox.push(...m);
    },
    failOnce(e) {
      failNext = e;
    },
  };
  return n;
}

export async function makeWorkspace(
  sql: Sql,
  opts: { config?: AttentionOSConfigInput; notifier?: Notifier; now?: () => Date; slug?: string } = {},
): Promise<WorkspaceContext> {
  const [row] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug, timezone) values ('Examplebrand Studio', ${opts.slug ?? `ws-${Math.random().toString(36).slice(2, 8)}`}, 'America/Chicago') returning id`;
  const root = mkdtempSync(join(tmpdir(), "ops-ws-"));
  tempRoots.push(root);
  const config = parseConfig({ workspace: { name: "Examplebrand Studio", timezone: "America/Chicago", preset: "coach-consultant" }, ...opts.config });
  return {
    id: row!.id,
    paths: { root, brand: join(root, "brand"), config: join(root, "config"), media: join(root, "media"), lessons: join(root, "brand/lessons.md"), state: join(root, ".attentionos") },
    config,
    brand: () => {
      throw new Error("not needed");
    },
    reloadBrand: () => {
      throw new Error("not needed");
    },
    sql,
    providers: { trendSources: {}, ...(opts.notifier ? { notifier: opts.notifier } : {}) },
    log: silentLogger,
    now: opts.now ?? (() => new Date()),
    secret: () => undefined,
  };
}
