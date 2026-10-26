// AttentionOS workspace settings.
//
// This file decides which parts of AttentionOS are switched on, which services it uses,
// how much it may spend, and how much each agent can do without asking you first.
// Everything here has a safe default, so you only change what you need.
//
// After editing, run `./aos doctor` (from your AttentionOS folder) to check the file. It explains any mistake
// in plain language.
//
// `attentionos/config` comes from the `attentionos` package listed in package.json.
// AttentionOS can read this file even before `npm install` has run.
import { defineConfig } from "attentionos/config";

export default defineConfig({
  // Who this workspace belongs to. The id is created for you; please don't change it.
  workspace: {
    id: "{{WORKSPACE_ID}}",
    name: "{{WORKSPACE_NAME}}",
    // The starting point for your lanes, cadence and trend sources (see the presets folder in the docs).
    preset: "{{PRESET}}",
    // Used for schedules, quiet hours and "film by" deadlines.
    timezone: "{{TIMEZONE}}",
  },

  // When your agents do AI work.
  // "copilot" (shown in Studio as "On request"): only when you ask, in Studio chat, Run now, approvals,
  //   Telegram or Claude Code. Studio-started work needs AttentionOS running (`./aos start`).
  // "autopilot": also on a schedule (overnight research, the morning brief). Keep AttentionOS running (`./aos start`).
  mode: "copilot",

  // What runs your agents' AI work.
  // "claude-code" (default): your own Claude Code, signed in with your Claude account on this machine, on your
  //   Claude plan. No API key and no per-run bill. Check it with `claude auth status`.
  // "api": the Claude Agent SDK with ANTHROPIC_API_KEY from .env, billed per use and capped by `budgets` below.
  // If `claude` isn't on your PATH, add claudeBin: "/full/path/to/claude".
  runner: { engine: "claude-code" },

  // The platforms you research, publish to and measure.
  // Options: instagram, tiktok, youtube, facebook, linkedin, x, threads.
  platforms: ["instagram", "tiktok", "youtube", "linkedin"],

  // Turn modules on or off. A module you leave out uses its defaults.
  // `schedules` overrides when a job runs (cron, in your timezone). An empty string switches that schedule off.
  // `settings` holds options that only that module understands.
  modules: {
    // The setup wizard in Studio: reads your website, learns your voice and interviews you for your Brand Kit.
    onboarding: { enabled: true, schedules: {}, settings: {} },
    research: { enabled: true, schedules: {}, settings: {} },
    strategy: { enabled: true, schedules: {}, settings: {} },
    scripting: { enabled: true, schedules: {}, settings: {} },
    // Level 2: needs ffmpeg and a speech-to-text model.
    editing: { enabled: false, schedules: {}, settings: {} },
    // Level 3: needs a publishing account (Zernio by default).
    publishing: { enabled: false, schedules: {}, settings: {} },
    // The daily loop in Studio: Film → upload your takes → the edit queue → approvals → scheduled posts.
    // Uses editing and publishing when they are on.
    production: {
      enabled: true,
      schedules: {},
      settings: {
        // Stop at the cut list for you to approve before the edit is planned. Off: you only review the finished video.
        reviewCuts: false,
        // Link an uploaded take to its script on its own when the match is clear.
        autoLink: true,
      },
    },
    community: { enabled: false, schedules: {}, settings: {} },
    learn: { enabled: true, schedules: {}, settings: {} },
    // A searchable memory of your Brand Kit, posts, scripts and research, kept in your own database.
    knowledge: { enabled: true, schedules: {}, settings: {} },
    ops: {
      enabled: true,
      schedules: {
        // Your morning brief arrives at 07:30 by default. To change it, uncomment and edit:
        // "ops.morning-brief": "0 8 * * 1-5",
      },
      settings: {
        // The same alert is sent at most once in this many minutes.
        alertDedupeMinutes: 180,
        // Demo mode hides real names (numbers stay real) so you can film or present safely.
        demoMode: false,
      },
    },
  },

  // How much each agent may do on its own.
  // "review_all": everything waits for your approval (the default, and the right start).
  // "review_key": only campaign posts and sensitive replies wait for you.
  // "autopilot": the agent acts and tells you afterwards.
  agents: {
    analyst: { autonomy: "review_all" },
    strategist: { autonomy: "review_all" },
    copywriter: { autonomy: "review_all" },
    art_director: { autonomy: "review_all" },
    publisher: { autonomy: "review_all" },
    community: { autonomy: "review_all" },
    chief_of_staff: { autonomy: "review_all" },
  },

  // Which outside service does each job. Keys and tokens live in .env, never in this file.
  providers: {
    publisher: "zernio", // zernio | blotato | manual
    inbox: "zernio", // zernio | blotato | none
    ownAnalytics: "zernio", // zernio | iggraph | blotato | csv
    scraper: "apify", // apify | iggraph | ytdlp | none
    asr: "whispercpp", // whispercpp | parakeet | openai
    renderer: "cut", // cut | motion (motion needs a Remotion license for companies of 4 or more people)
    imageGen: "none", // none | openai | gemini
    notifier: "telegram", // telegram | discord | email | console
    crm: "lite", // lite | webhook | sheets | gohighlevel | hubspot
    storage: "local", // local | s3 (supabase works too if you already use it)
  },

  // The knowledge store: your Brand Kit, posts, scripts and research, searchable by meaning and by keywords,
  // inside your own database. "local" (the default) runs a small embedding model on this computer: no key, no cost.
  // "openai" or "voyage" use OPENAI_API_KEY or VOYAGE_API_KEY from .env instead. Changing it re-indexes everything.
  knowledge: { embeddings: "local" },

  // Spending limits in US dollars. AttentionOS checks these before it spends, and alerts you instead of overspending.
  // perRunUsd and dailyUsd cap AI spend on the "api" engine; on your Claude plan nothing is billed per run.
  budgets: {
    perRunUsd: 2,
    dailyUsd: 5,
    scrapingMonthlyUsd: 29,
    imagesDailyUsd: 2,
  },

  // The one number every agent judges its work against.
  // Options: leads_per_week, follows_per_post, booked_calls_per_week, skip_rate, revenue_per_week.
  northStar: { metric: "leads_per_week" },

  // No notifications between these times (your local time, 24-hour clock). Urgent alerts wait until morning.
  quietHours: { start: "21:00", end: "07:00" },

  // Some features carry platform risk. They stay off until you have read the notice and set the flag to true.
  acknowledgements: {
    scrapingTerms: false,
    trialReelsRisk: false,
    automatedDmRisk: false,
    remotionLicense: false,
  },
});
