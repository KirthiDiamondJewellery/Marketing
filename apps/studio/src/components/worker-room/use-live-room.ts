"use client";
// Turns Studio's live stream into the room. Nothing here is simulated: a desk works only while its real agent is
// working, and every packet in the air was caused by a real event (a handoff, a run starting or finishing, a post
// going out). While an agent works, its three desks take turns on the job and pass it along, so the pad reads busy.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentState, LiveEvent } from "@/lib/live";
import { useLive } from "@/lib/use-live";
import { humanLabel } from "@/components/shell/format";
import { TEAM_BY_AGENT, TEAMS, type RobotId, type TeamId } from "./cast";
import { createClock } from "./clock";
import { WALL_PHONES, type Place } from "./layout";
import { P } from "./palette";
import type { DeskLive, DeskStatus, Desks, Flight, FlightKind, TeamLive } from "./types";

/** One desk's turn on a job, in ms. Matches the desk screens' story length. */
export const CYCLE = 3600;
const FLY = 1150;
const SPARK = 850;
/** A run that starts this soon after a handoff to it was already delivered by that handoff's packet. */
const HANDOFF_GRACE = 8000;

const CHIEF_KEY = "chief_of_staff";

function deskStatus(state: AgentState): DeskStatus {
  if (state === "working") return "work";
  if (state === "waiting") return "wait";
  if (state === "blocked") return "block";
  return "idle";
}

export interface LiveRoom {
  teams: Record<TeamId, TeamLive>;
  chief: { state: AgentState; label: string; status: DeskStatus; to: Place | null };
  desks: Desks;
  flights: readonly Flight[];
  ticket: { key: number; label: string } | null;
  wall: { shifts: number[]; flashes: number[] };
  working: number;
  total: number;
  clock: ReturnType<typeof createClock>;
}

export function useLiveRoom(still: boolean): LiveRoom {
  const live = useLive();
  const snap = live.snapshot;
  const clock = useMemo(() => createClock(), []);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [ticket, setTicket] = useState<{ key: number; label: string } | null>(null);
  const [wall, setWall] = useState<{ shifts: number[]; flashes: number[] }>(() => ({ shifts: Array(WALL_PHONES).fill(0), flashes: Array(WALL_PHONES).fill(0) }));
  const [tick, setTick] = useState(0);

  const sending = useRef(new Map<Place, { until: number; to: Place }>());
  const teamStart = useRef<Partial<Record<TeamId, number>>>({});
  const lastPass = useRef<Partial<Record<TeamId, number>>>({});
  const lastHandoffTo = useRef<Record<string, number>>({});
  const posts = useRef(0);
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const stillRef = useRef(still);
  stillRef.current = still;

  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);
  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
      set.clear();
    };
  }, []);

  const launch = useCallback(
    (kind: FlightKind, from: Place, to: Place, opts: { tint?: string; label?: string; phone?: number; dur?: number; onLand?: () => void } = {}) => {
      if (stillRef.current) {
        opts.onLand?.();
        return;
      }
      const dur = opts.dur ?? (kind === "read" || kind === "scan" ? SPARK : FLY);
      const f: Flight = { id: `f${++seq.current}`, kind, from, to, start: clock.now(), dur, tint: opts.tint ?? P.pink, label: opts.label, phone: opts.phone };
      setFlights((prev) => [...prev, f]);
      setTick((n) => n + 1);
      later(dur + 40, () => {
        setFlights((prev) => prev.filter((x) => x.id !== f.id));
        opts.onLand?.();
      });
    },
    [clock, later],
  );

  const send = useCallback((from: Place, to: Place) => {
    sending.current.set(from, { until: performance.now() + FLY, to });
    setTick((n) => n + 1);
  }, []);

  const placeOf = (agent: string, end: "first" | "last"): Place | null => {
    if (agent === CHIEF_KEY) return "chief";
    const team = TEAM_BY_AGENT[agent];
    if (!team) return null;
    return end === "first" ? team.robots[0] : team.robots[2];
  };

  // Real handoffs and posts going out.
  useEffect(() => {
    return live.onEvent((e: LiveEvent) => {
      if (e.kind === "handoff" && e.to) {
        const from = placeOf(e.agent, "last") ?? "chief";
        const to = placeOf(e.to, "first");
        if (!to || from === to) return;
        lastHandoffTo.current[e.to] = performance.now();
        const team = TEAM_BY_AGENT[e.to];
        const label = team?.ticket ?? "Brief";
        send(from, to);
        if (from === "chief") setTicket({ key: ++seq.current, label });
        launch("job", from, to, { tint: team?.tint ?? P.pink, label });
        return;
      }
      if (e.kind === "progress" && e.agent === "publisher" && /^published\b/i.test(e.message)) {
        const k = posts.current++ % WALL_PHONES;
        const from = TEAM_BY_AGENT.publisher!.robots[2];
        send(from, "wallL");
        launch("post", from, "wallL", {
          phone: k,
          onLand: () =>
            setWall((w) => ({
              shifts: w.shifts.map((s, i) => (i === k ? s + 1 : s)),
              flashes: w.flashes.map((f, i) => (i === k ? Date.now() : f)),
            })),
        });
      }
    });
  }, [live.onEvent, launch, send]);

  // Runs starting and finishing, from the snapshot.
  const prev = useRef<Map<string, { state: AgentState; runId: string | null }> | null>(null);
  useEffect(() => {
    if (!snap) return;
    const now = performance.now();
    const before = prev.current;
    const next = new Map(snap.agents.map((a) => [a.key as string, { state: a.state, runId: a.run?.id ?? null }]));
    prev.current = next;
    for (const a of snap.agents) {
      const team = TEAM_BY_AGENT[a.key];
      const was = before?.get(a.key);
      const working = a.state === "working";
      if (team && working && teamStart.current[team.id] === undefined) teamStart.current[team.id] = now;
      if (team && !working) {
        delete teamStart.current[team.id];
        delete lastPass.current[team.id];
      }
      if (!before || !was) continue;
      const started = working && (was.state !== "working" || (!!a.run?.id && a.run.id !== was.runId));
      const finished = was.state === "working" && !working;
      if (started) {
        if (team) teamStart.current[team.id] = now;
        if (!team) {
          launch("read", "core", "chief");
          continue;
        }
        team.robots.forEach((r, i) => later(420 + i * 170, () => launch("read", "core", r)));
        later(650, () => {
          if (performance.now() - (lastHandoffTo.current[a.key] ?? -Infinity) < HANDOFF_GRACE) return;
          const first = team.robots[0];
          if (team.id === "inbox") launch("comment", "wallL", first, { phone: posts.current % WALL_PHONES, tint: team.tint });
          else if (team.id === "research") launch("scan", "wallR", first, { phone: 2 });
          else {
            send("chief", first);
            setTicket({ key: ++seq.current, label: team.ticket });
            launch("job", "chief", first, { tint: team.tint, label: team.ticket });
          }
        });
      }
      if (finished && team) {
        const last = team.robots[2];
        send(last, "chief");
        launch("done", last, "chief", { tint: team.tint });
      }
    }
  }, [snap, launch, later, send]);

  // A light heartbeat while anything moves: desks take turns and pass the job along.
  const anyWorking = (snap?.agents ?? []).some((a) => a.state === "working");
  useEffect(() => {
    if (!anyWorking && flights.length === 0 && sending.current.size === 0) return;
    const id = setInterval(() => {
      const now = performance.now();
      for (const [k, v] of sending.current) if (v.until <= now) sending.current.delete(k);
      if (!stillRef.current) {
        for (const team of TEAMS) {
          const t0 = teamStart.current[team.id];
          if (t0 === undefined) continue;
          const n = Math.floor((now - t0) / CYCLE);
          if (n > (lastPass.current[team.id] ?? 0)) {
            lastPass.current[team.id] = n;
            const j = (n - 1) % 3;
            if (j < 2) {
              const from = team.robots[j]!;
              const to = team.robots[j + 1]!;
              sending.current.set(from, { until: now + FLY, to });
              launch("pass", from, to, { tint: team.tint });
            }
          }
        }
      }
      setTick((x) => x + 1);
    }, 200);
    return () => clearInterval(id);
  }, [anyWorking, flights.length, launch]);

  return useMemo(() => {
    void tick;
    const now = performance.now();
    const byKey = new Map((snap?.agents ?? []).map((a) => [a.key as string, a]));
    const teams = {} as Record<TeamId, TeamLive>;
    const desks = {} as Record<RobotId, DeskLive>;
    for (const team of TEAMS) {
      const a = byKey.get(team.agent);
      const state: AgentState = a?.enabled === false ? "paused" : (a?.state ?? "idle");
      teams[team.id] = { team: team.id, state, name: a?.name ?? team.name, label: humanLabel(a?.label), pending: a?.pendingApprovals ?? 0 };
      const t0 = teamStart.current[team.id];
      team.robots.forEach((r, i) => {
        const s = sending.current.get(r);
        let status = deskStatus(state);
        if (s && s.until > now && (status === "work" || status === "idle")) status = "send";
        const cycle = state === "working" && t0 !== undefined && !still ? Math.floor((now - t0 + (i * CYCLE) / 3) / CYCLE) : 0;
        desks[r] = { status, cycle, to: s && s.until > now ? s.to : null };
      });
    }
    const c = byKey.get(CHIEF_KEY);
    const chiefState: AgentState = c?.state ?? "idle";
    const cs = sending.current.get("chief");
    const chiefSending = !!cs && cs.until > now;
    const working = (snap?.agents ?? []).filter((a) => a.state === "working").length;
    return {
      teams,
      chief: { state: chiefState, label: humanLabel(c?.label), status: chiefSending ? "send" : deskStatus(chiefState), to: chiefSending ? cs.to : null },
      desks,
      flights,
      ticket,
      wall,
      working,
      total: snap?.agents.length || 7,
      clock,
    };
  }, [tick, snap, flights, ticket, wall, clock, still]);
}
