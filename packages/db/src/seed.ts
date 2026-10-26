import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Sql, TransactionSql } from "@attentionos/core";

/**
 * Seed loader (tests and local development). A seed folder holds one JSON file per table (`content.json`, `posts.json`, …), each an array of
 * rows without `workspace_id`, plus an optional `manifest.json` (workspace defaults, a reference "today", and
 * `links`: updates applied after every insert, for circular foreign keys).
 *
 * - Every row id is replaced by a fresh UUID, and every mention of an old id is rewritten: foreign keys, loose uuid
 *   columns and strings inside JSON columns. So the same seed loads into any number of workspaces.
 * - Insert order follows the foreign keys of the live schema (module tables work too); cycles are deferred.
 * - Dates: with a manifest `today`, every ISO timestamp is shifted so the data looks current (noon of `today` in the
 *   manifest timezone maps to now). Values may also be written relative to load time: "@now", "@now-3d", "@now+2h".
 */

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

export type SeedResult = { tables: { table: string; rows: number }[]; skipped: string[] };

export const seedManifestSchema = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().optional(),
  workspace: z.object({ name: z.string(), slug: z.string(), timezone: z.string().optional() }).partial().optional(),
  /** Preferred insert order; foreign keys still win if it disagrees with the live schema. */
  order: z.array(z.string()).optional(),
  links: z.array(z.object({ table: z.string(), id: z.string(), set: z.record(z.string(), z.unknown()) })).default([]),
}).passthrough();
export type SeedManifest = z.output<typeof seedManifestSchema>;

type Row = Record<string, unknown>;
type Column = { name: string; dataType: string; udt: string; identity: boolean; generated: boolean };
type ForeignKey = { column: string; target: string };
type TableInfo = { columns: Map<string, Column>; fks: ForeignKey[] };

const rowsSchema = z.array(z.record(z.string(), z.unknown()));
const RELATIVE_TIME = /^@now(?:([+-])(\d+(?:\.\d+)?)([smhdw]))?$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 };
const SKIP_TABLES = new Set(["workspaces", "workspace_members", "_aos_migrations"]);

export function readSeedDir(seedDir: string): { tables: Map<string, Row[]>; manifest: SeedManifest | null } {
  if (!existsSync(seedDir)) throw new SeedError(`Seed folder not found: ${seedDir}`);
  const tables = new Map<string, Row[]>();
  let manifest: SeedManifest | null = null;
  for (const file of readdirSync(seedDir).filter((f) => f.endsWith(".json")).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(seedDir, file), "utf8"));
    } catch (err) {
      throw new SeedError(`${file} is not valid JSON: ${(err as Error).message}`);
    }
    if (file === "manifest.json") {
      const m = seedManifestSchema.safeParse(parsed);
      if (!m.success) throw new SeedError(`manifest.json is invalid: ${m.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      manifest = m.data;
      continue;
    }
    const rows = rowsSchema.safeParse(parsed);
    if (!rows.success) throw new SeedError(`${file} must be an array of row objects.`);
    tables.set(file.slice(0, -".json".length), rows.data);
  }
  return { tables, manifest };
}

export function resolveRelativeTime(value: string, now: Date): string | null {
  const m = RELATIVE_TIME.exec(value);
  if (!m) return null;
  if (!m[1]) return now.toISOString();
  const delta = Number(m[2]) * UNIT_MS[m[3]!]! * (m[1] === "-" ? -1 : 1);
  return new Date(now.getTime() + delta).toISOString();
}

/** The UTC instant of a wall-clock time in a timezone (e.g. noon on the seed's "today" in America/Chicago). */
export function zonedTime(localIso: string, timezone: string): Date {
  const asUtc = new Date(`${localIso}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(asUtc).map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(asUtc.getTime() - (wall - asUtc.getTime()));
}

/** Milliseconds to add to seed timestamps so the manifest's "today" becomes the current day. */
export function seedShiftMs(manifest: SeedManifest | null, now: Date): number {
  if (!manifest?.today) return 0;
  // Shift by whole days so seeded times keep their clock time (a 6:30 pm post stays at 6:30 pm).
  const tz = manifest.timezone ?? "UTC";
  const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return zonedTime(`${localToday}T12:00:00`, tz).getTime() - zonedTime(`${manifest.today}T12:00:00`, tz).getTime();
}

async function introspect(sql: Sql | TransactionSql, tables: string[]): Promise<Map<string, TableInfo>> {
  const cols = await sql<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_identity: string; is_generated: string }[]>`
    select table_name, column_name, data_type, udt_name, is_identity, is_generated
      from information_schema.columns
     where table_schema = 'public' and table_name = any(${tables})`;
  const fks = await sql<{ table_name: string; column_name: string; target: string }[]>`
    select cl.relname as table_name, a.attname as column_name, tg.relname as target
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_class tg on tg.oid = c.confrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1
       and cl.relname = any(${tables})`;
  const info = new Map<string, TableInfo>();
  for (const c of cols) {
    const t = info.get(c.table_name) ?? { columns: new Map(), fks: [] };
    t.columns.set(c.column_name, {
      name: c.column_name,
      dataType: c.data_type,
      udt: c.udt_name,
      identity: c.is_identity === "YES",
      generated: c.is_generated === "ALWAYS",
    });
    info.set(c.table_name, t);
  }
  for (const fk of fks) info.get(fk.table_name)?.fks.push({ column: fk.column_name, target: fk.target });
  return info;
}

/** Orders tables so referenced tables come first. Cycles are broken by deferring the columns that close them. */
export function insertOrder(tables: string[], fks: Map<string, ForeignKey[]>, preferred: string[] = []): { order: string[]; deferred: Set<string> } {
  const set = new Set(tables);
  const rank = (t: string) => {
    const i = preferred.indexOf(t);
    return i === -1 ? preferred.length : i;
  };
  const byPreference = (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  const deps = new Map(tables.map((t) => [t, new Set((fks.get(t) ?? []).map((f) => f.target).filter((x) => x !== t && set.has(x)))]));
  const order: string[] = [];
  const deferred = new Set<string>();
  const remaining = new Set(tables);
  while (remaining.size) {
    // One table at a time, the most preferred among those whose references are already in place.
    const ready = [...remaining].filter((t) => [...deps.get(t)!].every((d) => !remaining.has(d))).sort(byPreference);
    if (ready.length) {
      order.push(ready[0]!);
      remaining.delete(ready[0]!);
      continue;
    }
    // Cycle: insert the table with the fewest unresolved references; those references are filled in afterwards.
    const pick = [...remaining].sort((a, b) => {
      const da = [...deps.get(a)!].filter((d) => remaining.has(d)).length;
      const db = [...deps.get(b)!].filter((d) => remaining.has(d)).length;
      return da - db || byPreference(a, b);
    })[0]!;
    for (const fk of fks.get(pick) ?? []) if (remaining.has(fk.target) && fk.target !== pick) deferred.add(`${pick}.${fk.column}`);
    order.push(pick);
    remaining.delete(pick);
  }
  return { order, deferred };
}

export type LoadSeedOptions = { now?: Date; manifest?: SeedManifest | null };

export async function loadSeed(sql: Sql, workspaceId: string, seedDir: string, opts: LoadSeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const { tables: files, manifest: fileManifest } = readSeedDir(seedDir);
  const manifest = opts.manifest === undefined ? fileManifest : opts.manifest;
  const shift = seedShiftMs(manifest, now);
  const skipped = [...files.keys()].filter((t) => SKIP_TABLES.has(t));
  for (const t of skipped) files.delete(t);

  return sql.begin(async (tx) => {
    const info = await introspect(tx, [...files.keys()]);
    for (const table of files.keys()) {
      if (!info.has(table)) throw new SeedError(`Seed file ${table}.json doesn't match a table. Is the module that owns it turned on and migrated?`);
    }

    // Phase 1: a fresh id for every row that names one, so any mention anywhere can be rewritten up front.
    const newIds = new Map<string, string>();
    const idTable = new Map<string, string>();
    for (const [table, rows] of files) {
      const idCol = info.get(table)!.columns.get("id");
      if (!idCol || idCol.udt !== "uuid") continue;
      for (const row of rows) {
        if (row.id === undefined || row.id === null) continue;
        const old = String(row.id);
        if (newIds.has(old)) throw new SeedError(`The id "${old}" is used twice (${idTable.get(old)} and ${table}).`);
        newIds.set(old, randomUUID());
        idTable.set(old, table);
      }
    }

    const time = (s: string): string | null => {
      const relative = resolveRelativeTime(s, now);
      if (relative) return relative;
      if (shift && ISO_TIMESTAMP.test(s)) return new Date(new Date(s).getTime() + shift).toISOString();
      return null;
    };
    const deep = (v: unknown): unknown => {
      if (typeof v === "string") return newIds.get(v) ?? time(v) ?? v;
      if (Array.isArray(v)) return v.map(deep);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
      return v;
    };

    const { order, deferred } = insertOrder([...files.keys()], new Map([...info].map(([t, i]) => [t, i.fks])), manifest?.order ?? []);
    const later: { table: string; id: string; column: string; value: string }[] = [];
    const counts: SeedResult["tables"] = [];

    for (const table of order) {
      const t = info.get(table)!;
      const fkByCol = new Map(t.fks.map((f) => [f.column, f.target]));
      let n = 0;
      for (const [index, source] of files.get(table)!.entries()) {
        const row: Row = {};
        for (const [key, raw] of Object.entries(source)) {
          if (key === "workspace_id") continue;
          const col = t.columns.get(key);
          if (!col) throw new SeedError(`${table}.json row ${index + 1}: unknown column "${key}".`);
          if (col.generated || (key === "id" && col.identity)) continue;
          let value = deep(raw);
          const target = fkByCol.get(key);
          if (target && value !== null && value !== undefined) {
            if (target === "workspaces") value = workspaceId;
            else if (typeof raw === "string" && !newIds.has(raw)) {
              throw new SeedError(`${table}.json row ${index + 1}: ${key} points to ${target} "${raw}", which isn't in the seed.`);
            } else if (deferred.has(`${table}.${key}`) || target === table) {
              // Cycles and self-references are set once every row exists.
              const self = newIds.get(String(source.id));
              if (!self) throw new SeedError(`${table}.json row ${index + 1}: rows with ${key} need an id.`);
              later.push({ table, id: self, column: key, value: value as string });
              value = null;
            }
          }
          row[key] = (col.dataType === "json" || col.dataType === "jsonb") && value !== null && value !== undefined ? tx.json(value as never) : value;
        }
        if (t.columns.has("workspace_id")) row.workspace_id = workspaceId;
        await tx`insert into ${tx(table)} ${tx(row, Object.keys(row))}`;
        n++;
      }
      counts.push({ table, rows: n });
    }

    const links = [...later, ...(manifest?.links ?? []).flatMap((l) =>
      Object.entries(l.set).map(([column, value]) => ({ table: l.table, id: newIds.get(l.id) ?? "", column, value: deep(value) as string, oldId: l.id })),
    )];
    for (const link of links) {
      if (!link.id) throw new SeedError(`A link updates ${link.table} row "${(link as { oldId?: string }).oldId ?? "?"}", which isn't in the seed.`);
      if (!info.get(link.table)?.columns.has(link.column)) throw new SeedError(`A link sets ${link.table}.${link.column}, which doesn't exist.`);
      await tx`update ${tx(link.table)} set ${tx(link.column)} = ${link.value} where id = ${link.id} and workspace_id = ${workspaceId}`;
    }
    return { tables: counts, skipped };
  });
}
