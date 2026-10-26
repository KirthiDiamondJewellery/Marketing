import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { ProviderError, type Logger } from "@attentionos/core";
import type { TelegramCall } from "./payload.ts";
import { UPLOAD_LIMITS } from "./payload.ts";

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

type ApiResponse<T> = { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };

const PROVIDER = "telegram";

/**
 * Minimal Bot API client. The token lives in the URL path, so URLs are never logged or put in errors.
 * Retries 429 (honouring retry_after), 5xx and network errors with backoff.
 */
export class TelegramClient {
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(private readonly opts: ClientOptions) {
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? "https://api.telegram.org";
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.request<T>(method, () => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    }), opts.timeoutMs);
  }

  /** Sends one planned call, uploading its file as multipart/form-data when present. */
  async send<T>(call: TelegramCall): Promise<T> {
    if (!call.file) return this.call<T>(call.method, call.params);
    const { field, localPath } = call.file;
    const size = (await stat(localPath).catch(() => {
      throw new ProviderError(PROVIDER, "invalid_request", `attachment not found: ${basename(localPath)}`);
    })).size;
    const limit = field === "photo" ? UPLOAD_LIMITS.photo : UPLOAD_LIMITS.other;
    if (size > limit) {
      throw new ProviderError(PROVIDER, "invalid_request", `${basename(localPath)} is ${Math.round(size / 1e6)} MB; Telegram bots can send up to ${limit / 1024 / 1024} MB`);
    }
    const bytes = await readFile(localPath);
    return this.request<T>(call.method, () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(call.params)) {
        if (v === undefined) continue;
        form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      form.append(field, new Blob([bytes]), basename(localPath));
      return { method: "POST", body: form };
    }, 5 * 60_000);
  }

  /** Downloads a file the user sent us (Bot API limit: 20 MB). */
  async download(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new ProviderError(PROVIDER, "not_found", "Telegram did not return a download path (files over 20 MB can't be fetched by bots)");
    const res = await this.fetch(`${this.baseUrl}/file/bot${this.opts.token}/${file.file_path}`).catch(() => {
      throw new ProviderError(PROVIDER, "upstream", "could not reach Telegram to download the file");
    });
    if (!res.ok) throw new ProviderError(PROVIDER, res.status === 404 ? "not_found" : "upstream", `file download failed (HTTP ${res.status})`, { status: res.status });
    return new Uint8Array(await res.arrayBuffer());
  }

  private async request<T>(method: string, init: () => RequestInit, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}/bot${this.opts.token}/${method}`;
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(url, { ...init(), signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? 30_000) });
      } catch (e) {
        if (attempt < maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new ProviderError(PROVIDER, "upstream", `could not reach Telegram (${method}): ${e instanceof Error ? e.name : "network error"}`);
      }
      let body: ApiResponse<T> | undefined;
      try {
        body = (await res.json()) as ApiResponse<T>;
      } catch {
        body = undefined;
      }
      if (res.ok && body?.ok) return body.result as T;

      const status = body?.error_code ?? res.status;
      const description = body?.description ?? `HTTP ${res.status}`;
      const retryAfterMs = body?.parameters?.retry_after !== undefined ? body.parameters.retry_after * 1000 : undefined;
      if ((status === 429 || status >= 500) && attempt < maxRetries) {
        const wait = retryAfterMs ?? backoff(attempt);
        this.opts.log.warn("telegram: retrying", { method, status, waitMs: wait });
        await this.sleep(wait);
        continue;
      }
      throw new ProviderError(PROVIDER, codeFor(status, description), `${method} failed: ${description}`, {
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        vendorCode: status,
      });
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function codeFor(status: number, description: string) {
  if (status === 401 || status === 404) return "auth" as const; // a wrong token answers 401 or 404
  if (status === 403) return "auth" as const; // bot blocked, kicked, or not allowed in the chat
  if (status === 429) return "rate_limited" as const;
  if (status === 409) return "conflict" as const; // another getUpdates/webhook consumer is active
  if (status >= 500) return "upstream" as const;
  if (/chat not found/i.test(description)) return "not_found" as const;
  return "invalid_request" as const;
}
