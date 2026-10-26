import type { AgentKey } from "@attentionos/core";

/**
 * The cast of the worker room. One floor pad per real agent, three little robots per pad (the agent's skills), and
 * the Chief of Staff on the dais. Team order is the order work moves around the room (clockwise from the Chief).
 */

export type TeamId = "research" | "planning" | "scripting" | "editing" | "publishing" | "inbox";

export type RobotId =
  | "trend" | "rival" | "transcript"
  | "ideas" | "lanes" | "slate"
  | "hook" | "script" | "voice"
  | "cutter" | "captions" | "remix"
  | "thumbs" | "scheduler" | "poster"
  | "comments" | "dm" | "leads";

export interface Team {
  id: TeamId;
  /** The real agent that runs this pad. */
  agent: Exclude<AgentKey, "chief_of_staff">;
  name: string;
  /** One short line for the camera bar while this team is resting. */
  line: string;
  /** Accent color for the pad, screens and packets. */
  tint: string;
  /** What a packet handed to this team is called. */
  ticket: string;
  robots: readonly [RobotId, RobotId, RobotId];
}

export const CHIEF_NAME = "Chief of Staff";
export const CORE_NAME = "Brand Brain";

export const TEAMS: readonly Team[] = [
  { id: "research", agent: "analyst", name: "Research", line: "Research finds what is working.", tint: "#8b5cf6", ticket: "Research", robots: ["trend", "rival", "transcript"] },
  { id: "planning", agent: "strategist", name: "Planning", line: "Planning picks what to film and when.", tint: "#b77dff", ticket: "Plan", robots: ["ideas", "lanes", "slate"] },
  { id: "scripting", agent: "copywriter", name: "Scripting", line: "Scripting writes it in your voice.", tint: "#d0a6ff", ticket: "Script", robots: ["hook", "script", "voice"] },
  { id: "editing", agent: "art_director", name: "Editing", line: "Editing cuts your takes into reels.", tint: "#8139fa", ticket: "Edit", robots: ["cutter", "captions", "remix"] },
  { id: "publishing", agent: "publisher", name: "Publishing", line: "Publishing posts it everywhere.", tint: "#a78bfa", ticket: "Post", robots: ["thumbs", "scheduler", "poster"] },
  { id: "inbox", agent: "community", name: "Inbox", line: "Inbox answers every comment and DM.", tint: "#6d7cff", ticket: "Reply", robots: ["comments", "dm", "leads"] },
];

export const ROBOT_NAME: Record<RobotId, string> = {
  trend: "Trend Scout",
  rival: "Competitor Watch",
  transcript: "Transcript Reader",
  ideas: "Idea Picker",
  lanes: "Lane Balance",
  slate: "Film List",
  hook: "Hook Writer",
  script: "Script Writer",
  voice: "Voice Check",
  cutter: "Cutter",
  captions: "Captions",
  remix: "Remix",
  thumbs: "Thumbnails",
  scheduler: "Scheduler",
  poster: "Cross-Poster",
  comments: "Comment Replies",
  dm: "DM Replies",
  leads: "Lead Logger",
};

export const TEAM_BY_AGENT: Record<string, Team> = Object.fromEntries(TEAMS.map((t) => [t.agent, t]));

export function teamById(id: TeamId): Team {
  const t = TEAMS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown team: ${id}`);
  return t;
}
