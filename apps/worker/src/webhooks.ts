import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ModuleDefinition, ProviderBase, WebhookCapable, WebhookRequest, WorkspaceContext } from "@attentionos/core";
import { enqueueRun } from "@attentionos/db";

/**
 * Webhook receiver (Zernio post.* / message.* / analytics.synced → worker).
 * `POST /webhooks/<provider>`: verified by the provider adapter when it offers `verifyWebhook`, otherwise by the
 * shared secret ATTENTIONOS_WEBHOOK_SECRET (header `x-attentionos-secret` or `?secret=`). The event becomes a queued
 * run: the adapter's `webhookJob()` picks the job, else the first enabled job named `<module>.webhook-<provider>`.
 */

export type { WebhookCapable, WebhookRequest, WebhookRoute } from "@attentionos/core";

export type WebhookServerOptions = {
  ws: WorkspaceContext;
  modules: ModuleDefinition[];
  port: number;
  host?: string;
  maxBodyBytes?: number;
};

const DELIVERY_HEADERS = ["webhook-id", "x-webhook-id", "x-delivery-id", "x-request-id"];

type WebhookProvider = Pick<ProviderBase, "id"> & WebhookCapable;

function providerInstances(ws: WorkspaceContext, provider: string): WebhookProvider[] {
  const values = [...Object.values(ws.providers), ...Object.values(ws.providers.trendSources)];
  const seen = new Set<unknown>();
  const out: WebhookProvider[] = [];
  for (const v of values) {
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if ((v as { id?: unknown }).id === provider) out.push(v as WebhookProvider);
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function conventionalWebhookJob(modules: ModuleDefinition[], provider: string): { jobId: string; agent: string } | null {
  for (const m of modules) {
    const job = m.jobs.find((j) => j.id === `${m.manifest.id}.webhook-${provider}`);
    if (job) return { jobId: job.id, agent: job.agent };
  }
  return null;
}

export async function handleWebhook(
  opts: Pick<WebhookServerOptions, "ws" | "modules">,
  provider: string,
  request: WebhookRequest,
  query: URLSearchParams,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { ws, modules } = opts;
  if (!/^[a-z0-9-]{1,40}$/.test(provider)) return { status: 404, body: { error: "unknown provider" } };
  const instances = providerInstances(ws, provider);
  const verifier = instances.find((i) => typeof i.verifyWebhook === "function");
  if (verifier) {
    if (!(await verifier.verifyWebhook!(request))) return { status: 401, body: { error: "signature check failed" } };
  } else {
    const secret = ws.secret("ATTENTIONOS_WEBHOOK_SECRET");
    const given = request.headers["x-attentionos-secret"] ?? query.get("secret") ?? "";
    if (!secret) return { status: 401, body: { error: "set ATTENTIONOS_WEBHOOK_SECRET in .env to accept webhooks from this provider" } };
    if (!safeEqual(given, secret)) return { status: 401, body: { error: "wrong webhook secret" } };
  }

  let payload: unknown = request.body;
  try {
    payload = request.body ? JSON.parse(request.body) : {};
  } catch {
    // keep the raw text; the job decides what to do with it
  }

  const router = instances.find((i) => typeof i.webhookJob === "function");
  const routed = router ? await router.webhookJob!(payload, request) : null;
  const fallback = routed ? null : conventionalWebhookJob(modules, provider);
  const jobId = routed?.jobId ?? fallback?.jobId;
  if (!jobId) {
    ws.log.warn("webhook ignored: no job handles it", { provider });
    return { status: instances.length ? 202 : 404, body: { queued: false, reason: `no job handles ${provider} webhooks` } };
  }
  const job = modules.flatMap((m) => m.jobs).find((j) => j.id === jobId);
  if (!job) return { status: 202, body: { queued: false, reason: `job ${jobId} is not enabled` } };

  const delivery = DELIVERY_HEADERS.map((h) => request.headers[h]).find(Boolean);
  const dedupeKey = routed?.dedupeKey ?? (delivery ? `webhook:${provider}:${delivery}` : undefined);
  const { id, deduped } = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId,
    agent: job.agent,
    trigger: "webhook",
    createdBy: `system`,
    input: routed?.input ?? { provider, payload },
    dedupeKey,
  });
  return { status: 202, body: { queued: true, runId: id, duplicate: deduped } };
}

export function createWebhookServer(opts: WebhookServerOptions): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const limit = opts.maxBodyBytes ?? 1_000_000;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      const match = /^\/webhooks\/([^/]+)\/?$/.exec(url.pathname);
      if (!match) return send(res, 404, { error: "not found" });
      if (req.method !== "POST") return send(res, 405, { error: "use POST" });
      const body = await readBody(req, limit);
      if (body === null) return send(res, 413, { error: "payload too large" });
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
      const out = await handleWebhook(opts, decodeURIComponent(match[1]!), { headers, body }, url.searchParams);
      send(res, out.status, out.body);
    } catch (err) {
      opts.ws.log.error("webhook failed", { error: (err as Error).message });
      send(res, 500, { error: "internal error" });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        server,
        url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
