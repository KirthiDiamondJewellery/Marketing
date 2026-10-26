/**
 * The live contract every Studio surface reads (agent map, activity stream, approvals, reel mode).
 * Built on the server by `src/server/snapshot.ts` and streamed over SSE from `/api/live`.
 */
import type { AgentKey } from "@attentionos/core";

export type AgentState = "working" | "waiting" | "idle" | "paused" | "blocked";

export type AgentLive = {
  key: AgentKey;
  name: string;
  monogram: string;
  role: string;
  state: AgentState;
  /** Plain-language status line, e.g. "Writing 4 captions for Thursday" or "2 posts need approval". */
  label: string;
  autonomy: "review_all" | "review_key" | "autopilot";
  enabled: boolean;
  pendingApprovals: number;
  run: { id: string; jobId: string; startedAt: string | null } | null;
  /** Finished runs and spend in the last 24 hours. */
  runs24h: number;
  costTodayUsd: number;
};

export type LiveEvent = {
  id: number;
  ts: string;
  agent: string;
  runId: string | null;
  kind: "progress" | "tool" | "text" | "error" | "handoff" | "cost" | "approval";
  message: string;
  /** For handoffs: the receiving agent key, when known. */
  to?: string;
};

export type ApprovalItem = {
  id: string;
  ref: string;
  kind: string;
  agent: string;
  summary: string;
  requestedAt: string;
  preview: unknown;
};

export type ScheduledPost = {
  id: string;
  platform: string;
  status: string;
  at: string | null;
  caption: string | null;
  title: string | null;
};

export type Snapshot = {
  generatedAt: string;
  workspace: { id: string; name: string; timezone: string; mode: "copilot" | "autopilot" };
  agents: AgentLive[];
  approvals: ApprovalItem[];
  queue: { queued: number; running: number; waitingApproval: number; failed24h: number };
  spend: { todayUsd: number; dailyBudgetUsd: number };
  posts: ScheduledPost[];
  events: LiveEvent[];
  /** Worker heartbeat seen in the last 2 minutes (Autopilot running 24/7). */
  workerOnline: boolean;
};

export type LiveMessage = { type: "snapshot"; data: Snapshot } | { type: "events"; data: LiveEvent[] };

export const AGENT_ROLES: Record<AgentKey, string> = {
  chief_of_staff: "Runs the team and talks to you",
  strategist: "Plans what to make and when",
  copywriter: "Writes scripts, hooks and captions",
  art_director: "Edits video and visuals",
  publisher: "Schedules and posts everywhere",
  community: "Handles comments, DMs and leads",
  analyst: "Researches and measures what works",
};
