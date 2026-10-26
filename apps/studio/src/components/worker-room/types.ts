import type { AgentState } from "@/lib/live";
import type { RobotId, TeamId } from "./cast";
import type { Place } from "./layout";

/** How one desk looks right now. Only "work" and "send" animate, and only while the real agent is working. */
export type DeskStatus = "work" | "send" | "wait" | "block" | "idle";

export interface DeskLive {
  status: DeskStatus;
  /** Bumps each time the desk screen should replay its story. */
  cycle: number;
  /** Where the robot is handing work, while status is "send". */
  to: Place | null;
}

export interface TeamLive {
  team: TeamId;
  state: AgentState;
  /** The agent's own name (Analyst, Copywriter...). */
  name: string;
  /** The agent's live status line. */
  label: string;
  pending: number;
}

export type FlightKind = "job" | "pass" | "done" | "post" | "comment" | "read" | "scan";

export interface Flight {
  id: string;
  kind: FlightKind;
  from: Place;
  to: Place;
  /** performance.now() when it took off. */
  start: number;
  dur: number;
  tint: string;
  /** Text on a job ticket. */
  label?: string;
  /** Which wall phone a feed flight uses. */
  phone?: number;
}

export interface FeedCard {
  id: string;
  /** Image URL (the workspace media route or the post's own thumbnail). Null draws a blank phone. */
  cover: string | null;
  views: number | null;
  title: string;
  platform: string;
  /** Whose post this is, for a competitor's post. Null for the workspace's own posts. */
  handle?: string | null;
}

export interface WallFeedData {
  cards: FeedCard[];
  handle: string | null;
  totalViews: number;
  totalPosts: number;
  /** Tracked competitors' scraped posts, shown on the right wall. */
  rivals?: FeedCard[];
  rivalCreators?: number;
}

export type Desks = Record<RobotId, DeskLive>;
