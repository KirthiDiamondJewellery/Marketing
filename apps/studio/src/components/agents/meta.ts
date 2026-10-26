import type { AgentKey } from "@attentionos/core";

/** What each agent does and which jobs Studio can start for it ("Run now"). Pure data, safe on client and server. */

export type RunnableJob = { id: string; label: string; description: string; ai: boolean };

export type AgentInfo = {
  key: AgentKey;
  name: string;
  monogram: string;
  role: string;
  about: string;
  owns: string[];
  jobs: RunnableJob[];
  /** Where to do this agent's work by hand when it has no native job. */
  studioLink?: { href: string; label: string };
};

export const AGENT_ORDER: AgentKey[] = ["chief_of_staff", "strategist", "copywriter", "art_director", "publisher", "community", "analyst"];

export const AGENT_INFO: Record<AgentKey, AgentInfo> = {
  chief_of_staff: {
    key: "chief_of_staff",
    name: "Chief of Staff",
    monogram: "Cs",
    role: "Runs the team and talks to you",
    about: "Sends your morning brief, routes your messages to the right agent, keeps the approvals queue moving and tells you when something breaks.",
    owns: ["Morning brief", "Chat", "Approvals", "Alerts and quiet hours"],
    jobs: [{ id: "ops.morning-brief", label: "Send the morning brief", description: "What to film, what's waiting and yesterday's results.", ai: false }],
  },
  strategist: {
    key: "strategist",
    name: "Strategist",
    monogram: "St",
    role: "Plans what to make and when",
    about: "Reads your lanes, funnel mix and last week's results, then picks what to film today and slots it on the calendar.",
    owns: ["Film today", "Calendar slots", "Funnel and lane balance"],
    jobs: [{ id: "strategy.daily-brief", label: "Plan today's filming", description: "News takes, outlier remixes and an offer piece, each with a deadline.", ai: false }],
  },
  copywriter: {
    key: "copywriter",
    name: "Copywriter",
    monogram: "Cw",
    role: "Writes scripts, hooks and captions",
    about: "Writes scripts in your voice, checks every claim, and drafts captions for each platform with the right keyword call to action.",
    owns: ["Scripts", "Hooks", "Captions per platform"],
    jobs: [{ id: "scripting.harvest-hooks", label: "Refresh hook banks", description: "Pulls fresh hooks from your best posts and competitor outliers.", ai: false }],
  },
  art_director: {
    key: "art_director",
    name: "Art Director",
    monogram: "Ad",
    role: "Edits video and visuals",
    about: "Cuts your raw takes into finished reels, applies your notes as new versions and runs a quality check before anything reaches you.",
    owns: ["Video edits", "Revisions", "Thumbnails", "Quality checks"],
    jobs: [],
    studioLink: { href: "/content", label: "Open Studio" },
  },
  publisher: {
    key: "publisher",
    name: "Publisher",
    monogram: "Pb",
    role: "Schedules and posts everywhere",
    about: "Schedules approved posts, cross-posts to every connected account, tracks links and reminds you when a post needs your hand.",
    owns: ["Scheduling", "Cross-posting", "Tracked links"],
    jobs: [{ id: "publishing.publish-due", label: "Publish what's due", description: "Sends approved posts and checks posts in flight. Safe any time.", ai: false }],
  },
  community: {
    key: "community",
    name: "Community",
    monogram: "Cm",
    role: "Handles comments, DMs and leads",
    about: "Sorts new comments and DMs, filters spam, drafts replies in your voice and flags hot leads for you to answer first.",
    owns: ["DM triage", "Reply drafts", "Keyword automations", "Lead handoff"],
    jobs: [{ id: "community.dm-triage", label: "Sort new DMs", description: "Filters noise and drafts replies. Never sends on its own.", ai: false }],
  },
  analyst: {
    key: "analyst",
    name: "Analyst",
    monogram: "An",
    role: "Researches and measures what works",
    about: "Watches competitors and trends, measures every post against your own normal and feeds what it learns back to the team.",
    owns: ["Competitor scans", "Trend radar", "Post-mortems", "Weekly briefing"],
    jobs: [
      { id: "research.competitor-scan", label: "Scan competitors", description: "Today's rotation of tracked creators, scored against their normal.", ai: false },
      { id: "research.trend-radar", label: "Check trends", description: "Which stories are moving fast enough to film today.", ai: false },
      { id: "learn.weekly-briefing", label: "Send the weekly briefing", description: "Your numbers for the week, best and weakest posts.", ai: false },
    ],
  },
};

export function isAgentKey(k: string): k is AgentKey {
  return k in AGENT_INFO;
}
