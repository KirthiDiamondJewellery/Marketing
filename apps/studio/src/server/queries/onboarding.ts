import "server-only";
import { AGENT_KEYS, competitorsSchema, type AgentKey, type AutonomyLevel } from "@attentionos/core";
import { parseYamlLoose, readLanes, type Lane } from "@attentionos/module-onboarding/brand-files";
import { matchAccounts, SCRAPER_PLATFORMS, type AccountMatch } from "@attentionos/module-onboarding/handles";
import { isStepId, prevStep, progress, STEP_IDS, STEP_TITLES, stepStatus, type OnboardingState, type StepId } from "@attentionos/module-onboarding/state";
import {
  brandFile,
  keySet,
  listPresets,
  loadState,
  runInfo,
  startBoard,
  systemChecks,
  type PresetCard,
  type RunInfo,
  type StartBoard,
  type SystemCheck,
} from "@/server/onboarding";
import { readWorkspaceConfig } from "@/server/settings";
import { workspace } from "@/server/workspace";

export type BrandBasics = {
  name: string;
  oneLiner: string;
  website: string;
  handles: Record<string, string>;
  bannedPhrases: string[];
};

export type SetupView = {
  state: OnboardingState;
  /** The step on screen (the URL may show a different one than the saved step). */
  step: StepId;
  /** The main rail. Computed here so client components never import the state module (it pulls in server-only packages). */
  steps: { id: StepId; title: string; status: "done" | "skipped" | "current" | "todo" }[];
  prev: StepId;
  progress: number;
  workspaceName: string;
  checks: SystemCheck[] | null;
  runs: Record<string, RunInfo>;
  brand: BrandBasics;
  /** Voice and ICP as they are on disk. */
  files: { voice: string; icp: string; proof: number };
  presets: PresetCard[];
  preset: string;
  lanes: Lane[];
  /** Creators in brand/competitors.yaml (what's tracked now). */
  tracked: { handle: string; platform: string }[];
  keys: Record<"ZERNIO_API_KEY" | "APIFY_TOKEN" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID", boolean>;
  scraper: string;
  /** Platforms the configured scraper can read. */
  scrapable: string[];
  publisher: string;
  /** The owner's handles lined up with the accounts connected in Zernio (last listed). */
  accounts: AccountMatch[];
  scrapingAcknowledged: boolean;
  board: StartBoard | null;
  team: { mode: "copilot" | "autopilot"; autonomy: Record<AgentKey, AutonomyLevel> };
};

function brandBasics(): BrandBasics {
  const raw = (parseYamlLoose(brandFile("brand.yaml")) ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && !v.includes("{{") ? v : "");
  return {
    name: str(raw.name),
    oneLiner: str(raw.oneLiner),
    website: str(raw.website),
    handles: raw.handles && typeof raw.handles === "object" ? (raw.handles as Record<string, string>) : {},
    bannedPhrases: Array.isArray(raw.bannedPhrases) ? (raw.bannedPhrases as unknown[]).filter((x): x is string => typeof x === "string") : [],
  };
}

const BOARD_STEPS: StepId[] = ["start", "review", "go-live"];

export async function getSetupView(requested?: string | null): Promise<SetupView> {
  const ws = workspace();
  const [state, cfg] = await Promise.all([loadState(ws), readWorkspaceConfig(ws.root)]);
  const config = cfg.ok ? cfg.config : ws.config;
  const step: StepId = isStepId(requested) ? requested : state.step;
  const d = state.data;
  const runs = await runInfo([d.business.runId, d.voice.runId, d.content.voiceRunId, d.interview.runId, d.strategy.suggestRunId, ...d.start.runIds, ...d.goLive.runIds], ws);
  const competitors = competitorsSchema.safeParse(parseYamlLoose(brandFile("competitors.yaml")) ?? {});
  const proof = parseYamlLoose(brandFile("proof-inventory.yaml")) as { items?: unknown[] } | null;
  const autonomy = Object.fromEntries(AGENT_KEYS.map((k) => [k, config.agents[k]?.autonomy ?? "review_all"])) as Record<AgentKey, AutonomyLevel>;
  const brand = brandBasics();
  const handles = Object.keys(d.content.handles).length ? d.content.handles : brand.handles;

  return {
    state,
    step,
    steps: STEP_IDS.map((id) => ({ id, title: STEP_TITLES[id], status: id === step ? "current" : stepStatus(state, id) === "current" ? "todo" : stepStatus(state, id) })),
    prev: prevStep(step),
    progress: progress(state),
    workspaceName: config.workspace.name,
    checks: step === "welcome" ? await systemChecks(ws) : null,
    runs,
    brand,
    files: { voice: brandFile("voice.md"), icp: brandFile("icp.md"), proof: Array.isArray(proof?.items) ? proof.items.length : 0 },
    presets: step === "review" ? listPresets() : [],
    preset: config.workspace.preset,
    lanes: readLanes(brandFile("pillars.md")),
    tracked: competitors.success ? competitors.data.creators.map((c) => ({ handle: c.handle, platform: c.platform })) : [],
    keys: {
      ZERNIO_API_KEY: keySet("ZERNIO_API_KEY", ws),
      APIFY_TOKEN: keySet("APIFY_TOKEN", ws),
      TELEGRAM_BOT_TOKEN: keySet("TELEGRAM_BOT_TOKEN", ws),
      TELEGRAM_CHAT_ID: keySet("TELEGRAM_CHAT_ID", ws),
    },
    scraper: config.providers.scraper,
    scrapable: [...(SCRAPER_PLATFORMS[config.providers.scraper] ?? [])],
    publisher: config.providers.publisher,
    accounts: matchAccounts(handles, d.connect.accounts),
    scrapingAcknowledged: config.acknowledgements.scrapingTerms,
    board: BOARD_STEPS.includes(step) && d.start.at ? await startBoard(d.start.at, ws) : null,
    team: { mode: config.mode, autonomy },
  };
}
