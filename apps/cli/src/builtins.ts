import { registerBuiltins } from "@attentionos/runtime";

/**
 * Every module and provider adapter shipped in the attentionos package. Static imports let the bundler include
 * them (each in its own chunk, loaded on first use). Regenerate with `node apps/cli/gen-builtins.cjs`.
 */
registerBuiltins({
  "@attentionos/module-community": () => import("@attentionos/module-community"),
  "@attentionos/module-editing": () => import("@attentionos/module-editing"),
  "@attentionos/module-knowledge": () => import("@attentionos/module-knowledge"),
  "@attentionos/module-learn": () => import("@attentionos/module-learn"),
  "@attentionos/module-onboarding": () => import("@attentionos/module-onboarding"),
  "@attentionos/module-ops": () => import("@attentionos/module-ops"),
  "@attentionos/module-production": () => import("@attentionos/module-production"),
  "@attentionos/module-publishing": () => import("@attentionos/module-publishing"),
  "@attentionos/module-research": () => import("@attentionos/module-research"),
  "@attentionos/module-scripting": () => import("@attentionos/module-scripting"),
  "@attentionos/module-strategy": () => import("@attentionos/module-strategy"),
  "@attentionos/module-trial-reels": () => import("@attentionos/module-trial-reels"),
  "@attentionos/provider-analytics-csv": () => import("@attentionos/provider-analytics-csv"),
  "@attentionos/provider-asr-whispercpp": () => import("@attentionos/provider-asr-whispercpp"),
  "@attentionos/provider-crm-webhook": () => import("@attentionos/provider-crm-webhook"),
  "@attentionos/provider-notify-console": () => import("@attentionos/provider-notify-console"),
  "@attentionos/provider-notify-discord": () => import("@attentionos/provider-notify-discord"),
  "@attentionos/provider-notify-telegram": () => import("@attentionos/provider-notify-telegram"),
  "@attentionos/provider-publish-blotato": () => import("@attentionos/provider-publish-blotato"),
  "@attentionos/provider-publish-zernio": () => import("@attentionos/provider-publish-zernio"),
  "@attentionos/provider-scrape-apify": () => import("@attentionos/provider-scrape-apify"),
  "@attentionos/provider-scrape-iggraph": () => import("@attentionos/provider-scrape-iggraph"),
  "@attentionos/provider-scrape-ytdlp": () => import("@attentionos/provider-scrape-ytdlp"),
  "@attentionos/provider-trends-web": () => import("@attentionos/provider-trends-web"),
});
