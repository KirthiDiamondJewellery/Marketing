import type { AttentionOSConfig, Logger, ProviderRegistry, TrendSource } from "@attentionos/core";
import { createLocalStorage } from "./local-storage.ts";
import { importOptional, type ImportSearch } from "./resolve.ts";

/**
 * Builds the ProviderRegistry from `config.providers`. Each choice maps to a provider package
 * `@attentionos/provider-<dir>` exporting `create({ secret, config, log })`. A package may also export
 * `create<Kind>()` (e.g. `createInbox`) when one package serves several kinds differently; otherwise the object
 * from `create()` is used for every kind it implements. Missing packages never throw: they show up in
 * `diagnostics` so `attentionos doctor` can explain them.
 */

export type ProviderKind = Exclude<keyof ProviderRegistry, "trendSources">;

export type ProviderDiagnostic = {
  kind: ProviderKind | "trendSource";
  choice: string;
  package?: string;
  status: "loaded" | "builtin" | "none" | "not_installed" | "failed";
  detail?: string;
};

export type ProviderCreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
};

/** choice → provider package directory. Choices absent here need no package (`manual`, `lite`, `none`, `local`). */
export const PROVIDER_PACKAGES: Record<ProviderKind, Record<string, string>> = {
  publisher: { zernio: "publish-zernio", blotato: "publish-blotato" },
  inbox: { zernio: "publish-zernio", blotato: "publish-blotato" },
  ownAnalytics: { zernio: "publish-zernio", blotato: "publish-blotato", iggraph: "scrape-iggraph", csv: "analytics-csv" },
  scraper: { apify: "scrape-apify", iggraph: "scrape-iggraph", ytdlp: "scrape-ytdlp" },
  asr: { whispercpp: "asr-whispercpp", parakeet: "asr-parakeet", openai: "asr-openai" },
  imageGen: { openai: "image-openai", gemini: "image-gemini" },
  notifier: { telegram: "notify-telegram", discord: "notify-discord", email: "notify-email", console: "notify-console" },
  crm: { webhook: "crm-webhook", sheets: "crm-webhook", gohighlevel: "crm-webhook", hubspot: "crm-webhook" },
  storage: { supabase: "storage-supabase", s3: "storage-s3" },
};

/** Trend source kinds (brand/sources.yaml) → package. */
export const TREND_PACKAGES: Record<string, string> = {
  rss: "trends-web",
  google_news: "trends-web",
  hn: "trends-web",
  reddit: "trends-web",
  github: "trends-web",
  x_apify: "scrape-apify",
};

const REQUIRED_METHODS: Record<ProviderKind, string[]> = {
  publisher: ["publish", "listAccounts", "health"],
  inbox: ["createDmAutomation", "listMessages", "health"],
  ownAnalytics: ["listPostMetrics", "health"],
  scraper: ["listCreatorPosts", "estimateCostUsd", "health"],
  asr: ["transcribe", "health"],
  imageGen: ["generate", "estimateCostUsd", "health"],
  notifier: ["send", "receive", "health"],
  crm: ["upsertLead", "health"],
  storage: ["put", "get", "url", "health"],
};

const KIND_FACTORY: Record<ProviderKind, string> = {
  publisher: "createPublisher",
  inbox: "createInbox",
  ownAnalytics: "createOwnAnalytics",
  scraper: "createScraper",
  asr: "createAsr",
  imageGen: "createImageGen",
  notifier: "createNotifier",
  crm: "createCrm",
  storage: "createStorage",
};

export function implementsKind(value: unknown, kind: ProviderKind): boolean {
  if (!value || typeof value !== "object") return false;
  return REQUIRED_METHODS[kind].every((m) => typeof (value as Record<string, unknown>)[m] === "function");
}

type PackageModule = Record<string, unknown>;

export async function buildProviderRegistry(
  config: AttentionOSConfig,
  opts: ProviderCreateOptions & {
    search?: ImportSearch;
    trendKinds?: string[];
    mediaDir?: string;
    /** Overrides for the choice → package map (tests, third-party adapters). */
    packages?: Partial<Record<ProviderKind, Record<string, string>>>;
  },
): Promise<{ providers: ProviderRegistry; diagnostics: ProviderDiagnostic[] }> {
  const providers: ProviderRegistry = { trendSources: {} };
  const diagnostics: ProviderDiagnostic[] = [];
  const modules = new Map<string, Promise<{ mod?: PackageModule; error?: string; reason?: "not_installed" | "failed" }>>();
  const instances = new Map<string, unknown>();
  const createOpts: ProviderCreateOptions = { secret: opts.secret, config: opts.config, log: opts.log };

  const load = (dir: string) => {
    if (!modules.has(dir)) {
      modules.set(
        dir,
        importOptional<PackageModule>(`@attentionos/provider-${dir}`, opts.search).then((r) =>
          r.ok ? { mod: r.module } : { error: r.error, reason: r.reason },
        ),
      );
    }
    return modules.get(dir)!;
  };

  const instantiate = async (dir: string, factoryName?: string): Promise<{ value?: unknown; error?: string; reason?: "not_installed" | "failed" }> => {
    const loaded = await load(dir);
    if (!loaded.mod) return { error: loaded.error, reason: loaded.reason };
    const factory = factoryName && typeof loaded.mod[factoryName] === "function" ? factoryName : "create";
    const key = `${dir}#${factory}`;
    if (!instances.has(key)) {
      const fn = loaded.mod[factory];
      if (typeof fn !== "function") return { error: `@attentionos/provider-${dir} has no create() export`, reason: "failed" };
      try {
        instances.set(key, await (fn as (o: ProviderCreateOptions) => unknown)(createOpts));
      } catch (err) {
        return { error: (err as Error).message, reason: "failed" };
      }
    }
    return { value: instances.get(key) };
  };

  for (const kind of Object.keys(PROVIDER_PACKAGES) as ProviderKind[]) {
    const choice = String(config.providers[kind]);
    if (kind === "storage" && choice === "local") {
      providers.storage = createLocalStorage(opts.mediaDir ?? "media");
      diagnostics.push({ kind, choice, status: "builtin" });
      continue;
    }
    const dir = opts.packages?.[kind]?.[choice] ?? PROVIDER_PACKAGES[kind][choice];
    if (!dir) {
      diagnostics.push({ kind, choice, status: "none" });
      continue;
    }
    const pkg = `@attentionos/provider-${dir}`;
    const made = await instantiate(dir, KIND_FACTORY[kind]);
    if (made.reason) {
      diagnostics.push({ kind, choice, package: pkg, status: made.reason, detail: made.error });
      continue;
    }
    if (made.value === undefined) {
      diagnostics.push({ kind, choice, package: pkg, status: "none" });
      continue;
    }
    if (!implementsKind(made.value, kind)) {
      diagnostics.push({ kind, choice, package: pkg, status: "failed", detail: `${pkg} doesn't provide a ${kind}` });
      continue;
    }
    (providers as Record<string, unknown>)[kind] = made.value;
    diagnostics.push({ kind, choice, package: pkg, status: "loaded" });
  }

  const trendKinds = opts.trendKinds ?? Object.keys(TREND_PACKAGES);
  for (const kind of trendKinds) {
    const dir = TREND_PACKAGES[kind];
    if (!dir) continue;
    const pkg = `@attentionos/provider-${dir}`;
    const loaded = await load(dir);
    if (!loaded.mod) {
      diagnostics.push({ kind: "trendSource", choice: kind, package: pkg, status: loaded.reason ?? "failed", detail: loaded.error });
      continue;
    }
    const made = typeof loaded.mod.createTrendSources === "function" ? await instantiate(dir, "createTrendSources") : await instantiate(dir);
    const source = pickTrendSource(made.value, kind, typeof loaded.mod.createTrendSources === "function");
    if (source) {
      providers.trendSources[kind] = source;
      diagnostics.push({ kind: "trendSource", choice: kind, package: pkg, status: "loaded" });
    } else {
      diagnostics.push({ kind: "trendSource", choice: kind, package: pkg, status: made.reason ?? "none", detail: made.error ?? `${pkg} has no ${kind} trend source` });
    }
  }

  return { providers, diagnostics };
}

function isTrendSource(v: unknown): v is TrendSource {
  return Boolean(v) && typeof (v as TrendSource).fetch === "function" && typeof (v as TrendSource).health === "function";
}

function pickTrendSource(value: unknown, kind: string, isRecord: boolean): TrendSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!isRecord && isTrendSource(value)) return value;
  const entry = (value as Record<string, unknown>)[kind];
  return isTrendSource(entry) ? entry : undefined;
}
