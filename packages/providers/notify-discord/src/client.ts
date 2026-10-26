import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { ProviderError, type Logger, type ProviderErrorCode } from "@attentionos/core";
import { UPLOAD_LIMIT_BYTES, type PlannedMessage } from "./payload.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ClientOptions = {
  token: string;
  log: Logger;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
};

const PROVIDER = "discord";

/** Minimal Discord REST client (bot token). Retries 429 using `retry_after`, plus 5xx and network errors. */
export class DiscordClient {
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(private readonly opts: ClientOptions) {
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? "https://discord.com/api/v10";
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, () => ({ method: "GET" }));
  }

  put(path: string): Promise<unknown> {
    return this.request(path, () => ({ method: "PUT" }));
  }

  async postMessage(channelId: string, planned: PlannedMessage): Promise<{ id: string }> {
    const path = `/channels/${channelId}/messages`;
    if (!planned.files.length) {
      return this.request(path, () => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(planned.payload) }));
    }
    const blobs: { bytes: Uint8Array; filename: string }[] = [];
    for (const f of planned.files) {
      const st = await stat(f.localPath).catch(() => {
        throw new ProviderError(PROVIDER, "invalid_request", `attachment not found: ${basename(f.localPath)}`);
      });
      if (st.size > UPLOAD_LIMIT_BYTES) {
        throw new ProviderError(PROVIDER, "invalid_request", `${f.filename} is ${Math.round(st.size / 1e6)} MB; Discord bots can upload up to ${UPLOAD_LIMIT_BYTES / 1024 / 1024} MB here`);
      }
      blobs.push({ bytes: await readFile(f.localPath), filename: f.filename });
    }
    return this.request(path, () => {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(planned.payload));
      blobs.forEach((b, i) => form.append(`files[${i}]`, new Blob([b.bytes]), b.filename));
      return { method: "POST", body: form };
    }, 5 * 60_000);
  }

  private async request<T>(path: string, init: () => RequestInit, timeoutMs?: number): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const base = init();
        res = await this.fetch(`${this.baseUrl}${path}`, {
          ...base,
          headers: { ...(base.headers as Record<string, string> | undefined), authorization: `Bot ${this.opts.token}`, "user-agent": "AttentionOS (https://github.com/evanbaker315/AttentionOS, 0.1)" },
          signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? 30_000),
        });
      } catch (e) {
        if (attempt < maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new ProviderError(PROVIDER, "upstream", `could not reach Discord: ${e instanceof Error ? e.name : "network error"}`);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (res.ok) return body as T;

      const err = (body ?? {}) as { message?: string; code?: number; retry_after?: number };
      const retryAfterMs = err.retry_after !== undefined ? Math.ceil(err.retry_after * 1000) : retryHeader(res);
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const wait = retryAfterMs ?? backoff(attempt);
        this.opts.log.warn("discord: retrying", { status: res.status, waitMs: wait });
        await this.sleep(wait);
        continue;
      }
      throw new ProviderError(PROVIDER, codeFor(res.status), err.message ?? `HTTP ${res.status}`, {
        status: res.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(err.code !== undefined ? { vendorCode: err.code } : {}),
      });
    }
  }
}

function retryHeader(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.ceil(n * 1000) : undefined;
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function codeFor(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return "invalid_request";
}
