// The camera tour: which stops it visits, how long it stays, and the math that turns a framed rectangle into one
// CSS transform. All pure.

import { CHIEF_NAME, CORE_NAME, TEAMS } from "./cast";
import type { Rect, StopId } from "./layout";

export interface Stop {
  id: StopId;
  label: string;
  /** One plain line shown while the camera is here (teams swap in their live status when they're working). */
  line: string;
  dwell: number;
}

const TEAM_STOPS: Stop[] = TEAMS.map((t) => ({ id: t.id, label: t.name, line: t.line, dwell: 6500 }));

export const STOPS: readonly Stop[] = [
  { id: "room", label: "Room", line: "Your whole content team, in one room.", dwell: 8000 },
  { id: "chief", label: "Chief", line: `The ${CHIEF_NAME} hands out the work.`, dwell: 6000 },
  { id: "brain", label: "Brain", line: `Every agent reads your ${CORE_NAME}.`, dwell: 5500 },
  ...TEAM_STOPS.filter((s) => s.id !== "inbox"),
  { id: "feed", label: "Feed", line: "Your best posts, with their real views.", dwell: 6500 },
  ...TEAM_STOPS.filter((s) => s.id === "inbox"),
];

export const MOVE_MS = 1700;
export const MAX_ZOOM = 2.05;

export function stopIndex(id: StopId): number {
  const i = STOPS.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

export const nextIndex = (i: number): number => (i + 1) % STOPS.length;
export const prevIndex = (i: number): number => (i - 1 + STOPS.length) % STOPS.length;

export interface Viewport {
  w: number;
  h: number;
  /** Space kept clear of the bars, in px. */
  top: number;
  bottom: number;
}

export interface CameraPose {
  k: number;
  tx: number;
  ty: number;
}

/** Fits `frame` inside the viewport. Used as translate(tx, ty) scale(k) with origin 0 0. */
export function fitCamera(frame: Rect, view: Rect, vp: Viewport, maxZoom = MAX_ZOOM): CameraPose {
  const availW = Math.max(1, vp.w);
  const availH = Math.max(1, vp.h - vp.top - vp.bottom);
  const k = Math.min(availW / frame.w, availH / frame.h, maxZoom);
  const cx = frame.x + frame.w / 2 - view.x;
  const cy = frame.y + frame.h / 2 - view.y;
  return { k, tx: availW / 2 - cx * k, ty: vp.top + availH / 2 - cy * k };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The part of the room the camera can see, in viewBox units. */
export function visibleRect(pose: CameraPose, view: Rect, vp: Viewport): Rect {
  return { x: view.x - pose.tx / pose.k, y: view.y - pose.ty / pose.k, w: vp.w / pose.k, h: vp.h / pose.k };
}
