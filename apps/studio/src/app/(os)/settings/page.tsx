import type { Metadata } from "next";
import { isDeepStrictEqual } from "node:util";
import { PageHeader } from "@/components/shell/page-header";
import { SettingsView, type SettingsData } from "@/components/settings/settings-view";
import { authSettings } from "@/server/auth";
import { studioVersion } from "@/server/doctor";
import { engineRoot, keyStatuses, listModules, moduleEnabled, PROVIDER_KEYS, PROVIDER_LABELS, readWorkspaceConfig } from "@/server/settings";
import { settingsApplyLive, settingsProblem } from "@/server/live-settings";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

function parseJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function load(): Promise<SettingsData> {
  const ws = workspace();
  const file = await readWorkspaceConfig(ws.root);
  // Show what's in the file (it may have been saved since Studio started); fall back to what Studio is running with.
  const config = file.ok ? file.config : ws.config;
  const keys = keyStatuses(ws.root);
  const isSet = new Map(keys.map((k) => [k.name, k.set]));
  const env = process.env;
  const auth = authSettings();
  const host = env.ATTENTIONOS_STUDIO_HOST ?? env.HOSTNAME ?? "localhost";
  const port = env.ATTENTIONOS_STUDIO_PORT ?? env.PORT ?? "4747";
  const problem = settingsProblem(ws.root);

  return {
    root: ws.root,
    version: studioVersion(),
    configError: file.ok ? null : file.error,
    restartNeeded: file.ok && !isDeepStrictEqual(file.config, ws.config),
    applyLive: settingsApplyLive(),
    applyProblem: problem ? { message: problem.message, ...(problem.fix ? { fix: problem.fix } : {}) } : null,
    workspace: { name: config.workspace.name, timezone: config.workspace.timezone, preset: config.workspace.preset, mode: config.mode },
    timezones: typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [],
    modules: listModules(engineRoot()).map((m) => ({ ...m, enabled: moduleEnabled(m, config) })),
    acknowledgements: { ...config.acknowledgements },
    providers: Object.entries(config.providers).map(([kind, choice]) => ({
      kind,
      label: PROVIDER_LABELS[kind] ?? kind,
      choice,
      keys: (PROVIDER_KEYS[kind]?.[choice] ?? []).map((name) => ({ name, set: isSet.get(name) ?? Boolean(env[name]) })),
    })),
    budgets: { ...config.budgets },
    keys: keys.map(({ name, label, purpose, where, editable, set, source }) => ({ name, label, purpose, where, editable, set, source })),
    access: {
      host,
      port,
      urls: parseJson<{ url: string; label: string }[]>(env.ATTENTIONOS_STUDIO_URLS, [{ url: `http://localhost:${port}`, label: "This computer" }]),
      signIn: auth.mode === "token",
      trustTailscale: auth.trustTailscale,
      workerEmbedded: env.ATTENTIONOS_WORKER === "embedded",
    },
  };
}

export default async function SettingsPage() {
  const data = await load();
  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <PageHeader
        title="Settings"
        description="How this workspace runs: what's switched on, what it may spend, which services it uses and how to reach Studio."
        meta={<span className="font-mono text-caption">{data.root}</span>}
      />
      <SettingsView data={data} />
    </div>
  );
}
