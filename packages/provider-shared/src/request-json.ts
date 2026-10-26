import { ProviderError, type ProviderErrorCode } from "@attentionos/core";
import type { FetchLike } from "./http-client.ts";

/** Coarser than HttpClient's codeForStatus (409 is a plain invalid request here); kept as the scrapers expect it. */
function requestCodeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 402) return "budget_exceeded";
  if (status >= 400 && status < 500) return "invalid_request";
  return "upstream";
}

/** JSON request with a timeout; vendor failures become ProviderError with a stable code. */
export async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number; provider: string },
): Promise<T> {
  const { timeoutMs = 30_000, provider, ...rest } = init;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ProviderError(provider, "upstream", `network error: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    let vendor: unknown = text;
    try {
      vendor = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const message = typeof vendor === "object" && vendor && "error" in vendor
      ? JSON.stringify((vendor as { error: unknown }).error)
      : text.slice(0, 300);
    throw new ProviderError(provider, requestCodeForStatus(res.status), `HTTP ${res.status}: ${message}`, {
      status: res.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      raw: vendor,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, "upstream", "response was not JSON");
  }
}
