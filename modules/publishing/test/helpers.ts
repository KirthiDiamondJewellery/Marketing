import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  brandSchema, createSql, parseConfig, ProviderError, silentLogger,
  type AttentionOSConfigInput, type BrandKit, type DmAutomation, type DmAutomationRequest, type Inbox, type InboxComment, type InboxMessage,
  type ProviderRegistry, type Publisher, type PublishRequest, type PublishResult, type SocialAccount, type Sql, type WorkspaceContext,
} from "@attentionos/core";
import { runMigrations } from "@attentionos/db";
import { databaseUrl as dbUrl } from "@attentionos/db/testing";

export { hasTestDatabase, NEEDS_DB } from "@attentionos/db/testing";

/**
 * Test harness for the publishing and community modules: one scratch database per test file
 * (`attentionos_test_o4_<name>`), schema v1 + both modules' migrations, the fictional demo brand
 * "Examplebrand Studio", a controllable clock and in-memory fake providers.
 */

const MIGRATIONS = (m: string) => fileURLToPath(new URL(`../../${m}/migrations`, import.meta.url));

export const NOW = new Date("2026-10-14T12:00:00Z"); // a Wednesday, 08:00 in New York

export type TestDb = { sql: Sql; drop(): Promise<void> };

/** Recreates `attentionos_test_o4_<name>` (admin connection on template1; the new database copies template0). */
export async function testDb(name: string): Promise<TestDb> {
  const db = `attentionos_test_o4_${name}`;
  const admin = createSql(dbUrl("template1"), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${db}" with (force)`);
    await admin.unsafe(`create database "${db}" template template0`);
  } finally {
    await admin.end();
  }
  const sql = createSql(dbUrl(db), { max: 4 });
  await runMigrations(sql, {
    moduleDirs: [{ dir: MIGRATIONS("publishing"), source: "publishing" }, { dir: MIGRATIONS("community"), source: "community" }],
  });
  return {
    sql,
    async drop() {
      await sql.end();
      const a = createSql(dbUrl("template1"), { max: 1 });
      try {
        await a.unsafe(`drop database if exists "${db}" with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}

export const IG_ACCOUNT: SocialAccount = { providerAccountId: "acct-ig", platform: "instagram", handle: "examplebrand.studio", status: "connected" };
export const TT_ACCOUNT: SocialAccount = { providerAccountId: "acct-tt", platform: "tiktok", handle: "examplebrand.studio", status: "connected" };
export const YT_ACCOUNT: SocialAccount = { providerAccountId: "acct-yt", platform: "youtube", handle: "examplebrandstudio", status: "connected" };

/** In-memory publisher + inbox that records calls; behaviour can be swapped per test. */
export class FakePublisher implements Publisher, Inbox {
  readonly id = "fakepub";
  supportsIdempotencyKeys = true;
  accounts: SocialAccount[] = [IG_ACCOUNT, TT_ACCOUNT, YT_ACCOUNT];
  published: PublishRequest[] = [];
  cancelled: string[] = [];
  automations: (DmAutomationRequest & { id: string })[] = [];
  sent: { conversationId: string; text: string }[] = [];
  replies: { commentId: string; text: string }[] = [];
  conversations: { id: string; lastMessageAt: string; participant: string }[] = [];
  messages: Record<string, InboxMessage[]> = {};
  comments: Record<string, InboxComment[]> = {};
  statuses = new Map<string, PublishResult>();
  failNext?: ProviderError;
  failAutomation?: ProviderError;
  private n = 0;

  async health() { return { ok: true, detail: "fake" }; }
  capabilities() {
    return { platforms: ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads"] as SocialAccount["platform"][], scheduling: true, instagramTrialReels: true, instagramCollaborators: true, firstComment: true };
  }
  async listAccounts() { return this.accounts; }
  async uploadMedia() { return { url: "https://cdn.examplebrand.example/media.mp4" }; }
  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    this.published.push(req);
    const res: PublishResult = { providerPostId: `pp-${++this.n}`, status: req.scheduledAt ? "scheduled" : "published", ...(req.scheduledAt ? { scheduledAt: req.scheduledAt } : { url: `https://social.example/p/${this.n}`, platformPostId: `native-${this.n}` }) };
    this.statuses.set(res.providerPostId, res);
    return res;
  }
  async getPost(id: string) {
    const s = this.statuses.get(id);
    if (!s) throw new ProviderError(this.id, "not_found", "no such post");
    return s;
  }
  async cancel(id: string) { this.cancelled.push(id); }
  async createDmAutomation(req: DmAutomationRequest): Promise<DmAutomation> {
    if (this.failAutomation) throw this.failAutomation;
    const id = `auto-${this.automations.length + 1}`;
    this.automations.push({ ...req, id });
    return { id, keyword: req.keyword, providerPostId: req.providerPostId, active: true };
  }
  async listDmAutomations() { return this.automations.map((a) => ({ id: a.id, keyword: a.keyword, providerPostId: a.providerPostId, active: true })); }
  async deleteDmAutomation(id: string) { this.automations = this.automations.filter((a) => a.id !== id); }
  async listConversations() { return this.conversations; }
  async listMessages(conversationId: string) { return this.messages[conversationId] ?? []; }
  async listComments(postId: string) { return this.comments[postId] ?? []; }
  async sendMessage(conversationId: string, text: string) { this.sent.push({ conversationId, text }); return { id: `m-${this.sent.length}` }; }
  async replyToComment(commentId: string, text: string) { this.replies.push({ commentId, text }); return { id: `r-${this.replies.length}` }; }
}

export function demoBrandKit(overrides: Record<string, unknown> = {}): BrandKit {
  return {
    dir: "/nonexistent/brand",
    brand: brandSchema.parse({
      name: "Examplebrand Studio",
      oneLiner: "Hand-bound notebooks and bookbinding workshops.",
      website: "https://examplebrand.example",
      timezone: "America/New_York",
      handles: { instagram: "@examplebrand.studio" },
      cta: { primary: "comment_keyword", siteUrl: "https://examplebrand.example", utmContentPrefix: "" },
      ...overrides,
    }),
    proofInventory: { items: [] },
    competitors: { creators: [] },
    sources: { sources: [] },
    docs: { voice: "# Voice\nWarm, practical, no hype." },
  };
}

export type TestWs = WorkspaceContext & { setNow(d: Date): void; fake: FakePublisher };

export async function testWorkspace(sql: Sql, opts: { config?: AttentionOSConfigInput; providers?: Partial<ProviderRegistry>; secrets?: Record<string, string>; noPublisher?: boolean } = {}): Promise<TestWs> {
  const slug = `qf-${randomUUID().slice(0, 8)}`;
  const [row] = await sql<{ id: string }[]>`insert into workspaces (name, slug, timezone) values ('Examplebrand Studio', ${slug}, 'America/New_York') returning id`;
  let now = NOW;
  const fake = new FakePublisher();
  const config = parseConfig({ workspace: { name: "Examplebrand Studio", timezone: "America/New_York" }, platforms: ["instagram", "tiktok", "youtube", "linkedin"], ...opts.config });
  const brand = demoBrandKit();
  const providers: ProviderRegistry = { trendSources: {}, ...(opts.noPublisher ? {} : { publisher: fake, inbox: fake }), ...opts.providers };
  return {
    id: row!.id,
    paths: { root: "/nonexistent", brand: "/nonexistent/brand", config: "/nonexistent/config", media: "/nonexistent/media", lessons: "/nonexistent/brand/lessons.md", state: "/nonexistent/.attentionos" },
    config,
    brand: () => brand,
    reloadBrand: () => brand,
    sql,
    providers,
    log: silentLogger,
    now: () => now,
    secret: (n) => opts.secrets?.[n],
    setNow(d: Date) { now = d; },
    fake,
  };
}

export const CAPTIONS = {
  instagram: { caption: "Three ways to make a hand-bound notebook last.\n\nComment STITCH and I'll send you the guide.", hashtags: ["#bookbinding", "#notebooks", "#handmade", "#papercraft", "#journaling"] },
  tiktok: { caption: "Three ways to make a hand-bound notebook last. DM me STITCH for the guide.", hashtags: ["#bookbinding", "#notebooks", "#handmade"] },
  youtube: { title: "Make a hand-bound notebook last", description: "Three ways to make a hand-bound notebook last.", hashtags: ["#bookbinding", "#notebooks", "#handmade"] },
  linkedin: { text: "Three ways to make a hand-bound notebook last. Comment STITCH and I'll send you the guide.", hashtags: ["#bookbinding", "#craft", "#smallbusiness"] },
};

/** Seeds a finished piece: content, reserved keyword, approved script with captions and a render. */
export async function seedContent(ws: WorkspaceContext, opts: { title?: string; keyword?: string | null; funnelStage?: "tofu" | "mofu" | "bofu"; captions?: Record<string, unknown>; ctaType?: string; status?: string } = {}): Promise<{ contentId: string; keywordId: string | null }> {
  const keyword = opts.keyword === undefined ? "stitch" : opts.keyword;
  const [c] = await ws.sql<{ id: string }[]>`
    insert into content (workspace_id, title, status, kind, funnel_stage, cta_type)
    values (${ws.id}, ${opts.title ?? "Make a notebook last"}, ${opts.status ?? "review"}, 'reel', ${opts.funnelStage ?? "tofu"}, ${opts.ctaType ?? (keyword ? "comment_keyword" : "follow")})
    returning id`;
  let keywordId: string | null = null;
  if (keyword) {
    const [k] = await ws.sql<{ id: string }[]>`insert into keywords (workspace_id, word, status, content_id) values (${ws.id}, ${keyword}, 'reserved', ${c!.id}) returning id`;
    keywordId = k!.id;
    await ws.sql`update content set keyword_id = ${keywordId} where id = ${c!.id}`;
  }
  await ws.sql`
    insert into scripts (workspace_id, content_id, version, body, captions, status)
    values (${ws.id}, ${c!.id}, 1, 'Spoken script body.', ${ws.sql.json((opts.captions ?? CAPTIONS) as never)}, 'approved')`;
  await ws.sql`
    insert into media_assets (workspace_id, content_id, kind, uri, duration_s)
    values (${ws.id}, ${c!.id}, 'render', '/tmp/examplebrand/renders/notebook.mp4', 32)`;
  return { contentId: c!.id, keywordId };
}
