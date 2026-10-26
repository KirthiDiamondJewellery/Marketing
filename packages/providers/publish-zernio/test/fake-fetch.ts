import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Recorded-fixture fetch: routes `METHOD path` to canned responses and records every call. No network. */

export type Canned = { status?: number; body?: unknown; headers?: Record<string, string> };
export type Route = { method: string; match: string | RegExp; respond: Canned | Canned[] | ((call: Call) => Canned) };
export type Call = { method: string; url: string; path: string; headers: Record<string, string>; body?: unknown; rawBody?: string };

export function fixture(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const counters = new Map<Route, number>();
  const impl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    const call: Call = { method, url: input, path: url.pathname, headers, ...(rawBody ? { rawBody, body: JSON.parse(rawBody) as unknown } : {}) };
    calls.push(call);
    const route = routes.find((r) => r.method === method && (typeof r.match === "string" ? url.pathname.endsWith(r.match) : r.match.test(url.pathname + url.search)));
    if (!route) return new Response(JSON.stringify({ error: `no fixture for ${method} ${url.pathname}` }), { status: 599 });
    let canned: Canned;
    if (typeof route.respond === "function") canned = route.respond(call);
    else if (Array.isArray(route.respond)) {
      const n = counters.get(route) ?? 0;
      counters.set(route, n + 1);
      canned = route.respond[Math.min(n, route.respond.length - 1)]!;
    } else canned = route.respond;
    const status = canned.status ?? 200;
    const body = canned.body === undefined || status === 204 ? null : JSON.stringify(canned.body);
    return new Response(body, { status, headers: { "content-type": "application/json", ...canned.headers } });
  };
  return { fetch: impl, calls };
}

export const noSleep = () => {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
};
