import { ProviderError, type Logger, type ProviderErrorCode } from "@attentionos/core";
import type { z } from "zod";

/**
 * Small fetch wrapper shared by the adapters' endpoints:
 * - retries 429 and 5xx (and network errors) with exponential backoff + jitter, honoring Retry-After;
 * - optional minimum spacing between requests (some vendors throttle bursts);
 * - per-request timeout (uploads get a longer one);
 * - maps every failure to a ProviderError with a stable code, never a vendor error.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpOptions = {
  provider: string;
  baseUrl: string;
  headers: () => Record<string, string>;
  log: Logger;
  fetch?: FetchLike;
  /** Retries after the first attempt for 429/5xx/network errors. */
  maxRetries?: number;
  /** Minimum delay between the start of two requests, ms. */
  minSpacingMs?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Turns an error response body into a message and vendor code. */
  describeError?: (status: number, body: unknown) => { message?: string; vendorCode?: string | number; code?: ProviderErrorCode };
  /** For vendors that put the wait in the error body instead of a Retry-After header. */
  retryAfterFromBody?: (body: unknown) => number | undefined;
};

export type RequestOptions<S extends z.ZodType | undefined> = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Pre-serialised JSON body (when a signature must cover the exact bytes). Wins over `body`. */
  rawBody?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  schema?: S;
  /**
   * true (default): retry 429, 5xx and network errors. "rate_limited": retry only 429s (the request was refused, so
   * nothing happened); use it for writes the vendor can't dedupe. false: never retry.
   */
  retry?: boolean | "rate_limited";
};

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return undefined;
}

export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 402) return "budget_exceeded";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return "invalid_request";
}

export class HttpClient {
  private lastStart = 0;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  url(path: string, query?: RequestOptions<undefined>["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.opts.baseUrl.replace(/\/$/, "")}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  async request<S extends z.ZodType | undefined = undefined>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    ro: RequestOptions<S> = {},
  ): Promise<S extends z.ZodType ? z.output<S> : unknown> {
    const maxRetries = ro.retry === false ? 0 : this.opts.maxRetries ?? 4;
    const onlyRateLimits = ro.retry === "rate_limited";
    const url = this.url(path, ro.query);
    const payload = ro.rawBody ?? (ro.body !== undefined ? JSON.stringify(ro.body) : undefined);
    let attempt = 0;
    for (;;) {
      await this.space();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ro.timeoutMs ?? this.opts.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            accept: "application/json",
            ...(payload !== undefined ? { "content-type": "application/json" } : {}),
            ...this.opts.headers(),
            ...ro.headers,
          },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const aborted = (err as Error).name === "AbortError";
        if (attempt < maxRetries && !onlyRateLimits) {
          attempt++;
          const wait = this.backoff(attempt);
          this.opts.log.warn(`${this.opts.provider}: network error, retrying`, { method, path, attempt, waitMs: wait });
          await this.sleep(wait);
          continue;
        }
        throw new ProviderError(this.opts.provider, "upstream", aborted ? `request timed out (${method} ${path})` : `network error (${method} ${path}): ${(err as Error).message}`);
      }
      clearTimeout(timer);

      const text = await res.text();
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      if (res.ok) {
        if (!ro.schema) return body as never;
        const parsed = ro.schema.safeParse(body ?? {});
        if (!parsed.success) {
          throw new ProviderError(this.opts.provider, "upstream", `unexpected response shape from ${method} ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { status: res.status, raw: body });
        }
        return parsed.data as never;
      }

      const retryable = res.status === 429 || (res.status >= 500 && !onlyRateLimits);
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.now()) ?? this.opts.retryAfterFromBody?.(body);
      if (retryable && attempt < maxRetries) {
        attempt++;
        const wait = Math.min(MAX_DELAY_MS, retryAfterMs ?? this.backoff(attempt));
        this.opts.log.warn(`${this.opts.provider}: ${res.status}, retrying`, { method, path, attempt, waitMs: wait });
        await this.sleep(wait);
        continue;
      }
      const described = this.opts.describeError?.(res.status, body) ?? {};
      throw new ProviderError(
        this.opts.provider,
        described.code ?? codeForStatus(res.status),
        described.message ?? `${method} ${path} failed with HTTP ${res.status}`,
        { status: res.status, retryAfterMs, vendorCode: described.vendorCode, raw: body },
      );
    }
  }

  private backoff(attempt: number): number {
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  private async space(): Promise<void> {
    const gap = this.opts.minSpacingMs ?? 0;
    if (gap > 0 && this.lastStart > 0) {
      const wait = this.lastStart + gap - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastStart = this.now();
  }
}
