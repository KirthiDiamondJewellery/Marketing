"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { LiveEvent, LiveMessage, Snapshot } from "./live";

type LiveState = {
  snapshot: Snapshot | null;
  /** Rolling buffer of the most recent events (newest last). */
  events: LiveEvent[];
  connected: boolean;
  /** Subscribe to each new event as it arrives (for motion triggers like relay comets). Returns an unsubscribe. */
  onEvent(fn: (e: LiveEvent) => void): () => void;
  /** Inject synthetic events (reel/demo mode) so every surface reacts as if they were real. */
  inject(events: LiveEvent[]): void;
};

const LiveContext = createContext<LiveState | null>(null);
const MAX_EVENTS = 200;

/** Mount once in the OS layout. Streams /api/live and shares it with every Studio surface. */
export function LiveProvider({ children, initial }: { children: ReactNode; initial?: Snapshot | null }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(initial ?? null);
  const [events, setEvents] = useState<LiveEvent[]>(initial?.events ?? []);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());

  const seen = useRef(new Set<number>((initial?.events ?? []).map((e) => e.id)));
  const push = (incoming: LiveEvent[]) => {
    // Snapshots and the event stream can overlap; each event id is delivered once.
    const fresh = incoming.filter((e) => !seen.current.has(e.id));
    if (!fresh.length) return;
    for (const e of fresh) seen.current.add(e.id);
    if (seen.current.size > MAX_EVENTS * 5) seen.current = new Set([...seen.current].slice(-MAX_EVENTS * 2));
    setEvents((prev) => [...prev, ...fresh].slice(-MAX_EVENTS));
    for (const e of fresh) for (const fn of listeners.current) fn(e);
  };

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const open = () => {
      source = new EventSource("/api/live");
      source.onopen = () => {
        failures = 0;
        setConnected(true);
      };
      source.onmessage = (m) => {
        const msg = JSON.parse(m.data) as LiveMessage;
        if (msg.type === "snapshot") setSnapshot(msg.data);
        else push(msg.data);
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        // Quick first retry: a settings save restarts Studio in a second or two.
        retry = setTimeout(open, failures++ === 0 ? 1000 : 3000);
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  const value: LiveState = {
    snapshot,
    events,
    connected,
    onEvent(fn) {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
    inject: push,
  };
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used inside <LiveProvider>");
  return ctx;
}
