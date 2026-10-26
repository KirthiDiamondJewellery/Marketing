"use client";
// The worker room: a dark isometric room where each agent is a pad of little robots, the Chief of Staff runs the
// floor from a dais and the Brand Brain glows in the middle. One SVG on a stage that the camera moves with a single
// CSS transform. Everything that lights up or flies is driven by Studio's live feed (see use-live-room.ts).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLive } from "@/lib/use-live";
import { useShowcaseReduced } from "@/motion/reduced";
import { CHIEF_NAME, ROBOT_NAME, TEAMS, type RobotId, type TeamId } from "./cast";
import { fitCamera, MOVE_MS, overlaps, STOPS, visibleRect } from "./camera";
import { ChiefDais } from "./ChiefDais";
import { Core } from "./Core";
import { Racks, RACKS_DEPTH } from "./Decor";
import { Defs } from "./Defs";
import { Flights } from "./Flights";
import { grouped, iso } from "./iso";
import { anchor, CHIEF, CORE, FRAMES, ROOM_TALL, SPOTS, VIEW, type Place, type StopId } from "./layout";
import { P } from "./palette";
import type { Dir } from "./Robot";
import { CoversContext } from "./screens/bits";
import { Shell } from "./Shell";
import { Station } from "./Station";
import { statusText, Tag, TeamTags } from "./TeamTags";
import type { Fullscreen } from "./use-fullscreen";
import { useLiveRoom } from "./use-live-room";
import { useTour } from "./use-tour";
import { WallFeed } from "./WallFeed";
import { Walls } from "./Walls";
import type { WallFeedData } from "./types";
import "./worker-room.css";

function dirTo(from: Place, to: Place | null): Dir {
  if (!to) return "0";
  const dx = anchor(to)[0] - anchor(from)[0];
  return Math.abs(dx) < 6 ? "0" : dx > 0 ? "r" : "l";
}

/** Space the bars need, so the camera keeps its subject clear of them. */
function safeArea(w: number, h: number, wide: boolean, framed: boolean): { top: number; bottom: number } {
  const phone = w < 720 || h > w;
  if (phone) return { top: 52, bottom: framed ? 150 : 96 };
  return wide ? { top: 44, bottom: framed ? 80 : 56 } : { top: 60, bottom: framed ? 96 : 64 };
}

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((p) => (p.w === r.width && p.h === r.height ? p : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

interface FloorItem {
  key: string;
  depth: number;
  node: ReactNode;
}

/**
 * `framed`: drawn inside the Studio page (not full screen), so the bottom bar keeps clear of the floating chat button.
 */
export function WorkerRoom({ feed, full, hold: startHeld = false, framed = false }: { feed: WallFeedData; full?: Fullscreen; hold?: boolean; framed?: boolean }) {
  const { snapshot } = useLive();
  const still = useShowcaseReduced();
  const room = useLiveRoom(still);
  const tour = useTour(startHeld, still);
  const box = useRef<HTMLDivElement>(null);
  const size = useSize(box);
  const { jump, step, toggleHold } = tour;

  const stop = tour.hold ? STOPS[0]! : tour.stop;
  const viewport = useMemo(() => ({ w: size.w, h: size.h, ...safeArea(size.w, size.h, stop.id === "room", framed) }), [size, stop.id, framed]);
  const tall = viewport.h > viewport.w * 1.25;
  const pose = useMemo(() => fitCamera(stop.id === "room" && tall ? ROOM_TALL : FRAMES[stop.id], VIEW, viewport), [stop.id, tall, viewport]);
  const seen = useMemo(() => visibleRect(pose, VIEW, viewport), [pose, viewport]);
  const sees = useCallback((id: StopId) => overlaps(seen, FRAMES[id]), [seen]);

  const pickRobot = useCallback((id: RobotId) => jump(SPOTS[id].team), [jump]);
  const pickChief = useCallback(() => jump("chief"), [jump]);
  const pickBrain = useCallback(() => jump("brain"), [jump]);
  const pickFeed = useCallback(() => jump("feed"), [jump]);

  const states = useMemo(() => Object.fromEntries(TEAMS.map((t) => [t.id, room.teams[t.id].state])) as Record<TeamId, (typeof room.teams)[TeamId]["state"]>, [room.teams]);
  const covers = useMemo(() => feed.cards.map((c) => c.cover).filter((c): c is string => !!c), [feed.cards]);

  const floor: FloorItem[] = [
    {
      key: "chief",
      depth: CHIEF.x + CHIEF.y,
      node: <ChiefDais status={room.chief.status} dir={dirTo("chief", room.chief.to)} ticket={room.ticket} tint={room.ticket ? (TEAMS.find((t) => t.ticket === room.ticket?.label)?.tint ?? P.pink) : P.pink} off={!sees("chief")} onPick={pickChief} />,
    },
    {
      key: "core",
      depth: CORE.x + CORE.y,
      node: (
        <g onClick={pickBrain} className="wr-pick">
          <Core busy={room.working > 0} off={!sees("brain")} />
        </g>
      ),
    },
    { key: "racks", depth: RACKS_DEPTH, node: <Racks /> },
    ...TEAMS.flatMap((team) =>
      team.robots.map((id, i) => {
        const spot = SPOTS[id];
        const d = room.desks[id];
        return {
          key: id,
          depth: spot.cx + spot.cy,
          node: <Station spot={spot} name={ROBOT_NAME[id]} tint={team.tint} status={d.status} cycle={d.cycle} dir={dirTo(id, d.to)} breath={(i * 1.3 + TEAMS.indexOf(team) * 0.7) % 4} off={!sees(team.id)} onPick={pickRobot} />,
        };
      }),
    ),
  ].sort((a, b) => a.depth - b.depth);

  const ready = size.w > 0 && size.h > 0;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!ready || armed) return;
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [ready, armed]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "h" || e.key === "H") toggleHold();
    else if ((e.key === "f" || e.key === "F") && full?.supported) full.toggle();
    else return;
    e.preventDefault();
  };

  const name = snapshot?.workspace.name ?? "";
  // Wall tickers: the workspace's totals, and who the right wall is studying once competitors have been scraped.
  const totals = feed.totalPosts ? `${grouped(feed.totalViews)} VIEWS   ${grouped(feed.totalPosts)} POSTS` : "";
  const own = (feed.handle ? `@${feed.handle}` : name).toUpperCase();
  const rivalCount = feed.rivalCreators ?? 0;
  const wallRight = feed.rivals?.length ? `STUDYING ${rivalCount} ${rivalCount === 1 ? "COMPETITOR" : "COMPETITORS"}` : totals;
  const wallLeft = feed.rivals?.length && totals ? `${own}   ${totals}` : own;
  const stopLine = stop.id === "feed" && feed.rivals?.length ? "Your best posts on the left. Your competitors' on the right." : stop.line;
  const line = captionFor(stop.id, stopLine, room);
  const [hx, hy] = iso(CHIEF.x, CHIEF.y, CHIEF.z + 0.55);
  const chiefText = statusText({ team: "research", state: room.chief.state, name: CHIEF_NAME, label: room.chief.label, pending: 0 });

  return (
    <div className={`wr${still ? " is-still" : ""}${framed ? " is-framed" : ""}`} onKeyDown={onKey} tabIndex={0} aria-label="Worker room. Arrow keys move the camera, H holds the wide shot.">
      <div className="wr-room" ref={box}>
        <div
          className="wr-stage"
          style={{
            width: VIEW.w,
            height: VIEW.h,
            transform: `translate(${pose.tx.toFixed(2)}px, ${pose.ty.toFixed(2)}px) scale(${pose.k.toFixed(4)})`,
            transitionDuration: still || !armed ? "0ms" : `${MOVE_MS}ms`,
            visibility: ready ? "visible" : "hidden",
          }}
        >
          <CoversContext.Provider value={covers}>
            <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} width={VIEW.w} height={VIEW.h} role="img" aria-label={roomLabel(room)}>
              <Defs />
              <Shell states={states} chief={room.chief.state} />
              <Walls right={wallRight} left={wallLeft} />
              <g onClick={pickFeed} className="wr-pick">
                <WallFeed cards={feed.cards} rivals={feed.rivals} handle={feed.handle} shifts={room.wall.shifts} flashes={room.wall.flashes} />
              </g>
              {floor.map((f) => (
                <g key={f.key}>{f.node}</g>
              ))}
              <TeamTags teams={room.teams} />
              {chiefText ? <Tag x={hx} y={hy - 166} name="Chief" text={chiefText.length > 36 ? `${chiefText.slice(0, 35)}…` : chiefText} state={room.chief.state} tint={P.pink} /> : null}
              {!still && <Flights flights={room.flights} clock={room.clock} />}
            </svg>
          </CoversContext.Provider>
        </div>
      </div>

      <header className="wr-topbar">
        <div className="wr-brand">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
            <circle cx="11" cy="11" r="10.5" fill="#0b0712" />
            <path d="M 15.6 4.6 A 7 7 0 1 1 11.6 4.03" fill="none" stroke={P.magenta} strokeWidth="2.4" />
          </svg>
          <span>{name || "Your studio"}</span>
        </div>
        <div className="wr-top-right">
          <div className="wr-live" aria-live="polite">
            <i className={`wr-live-dot${room.working ? " is-on" : ""}`} />
            <b className="wr-num">{room.working}</b>
            <span className="wr-live-of">of {room.total}</span>
            <span>{room.working === 1 ? "agent working" : "agents working"}</span>
          </div>
        </div>
      </header>

      <footer className="wr-tourbar">
        <p className="wr-caption" key={line}>
          {line}
        </p>
        <nav className="wr-stops" aria-label="Camera">
          {STOPS.map((s, i) => (
            <button key={s.id} type="button" className={`wr-stop${i === tour.index && !tour.hold ? " is-on" : ""}${isLive(s.id, room) ? " is-live" : ""}`} aria-pressed={i === tour.index && !tour.hold} aria-label={`Show ${s.label}`} onClick={() => jump(s.id)}>
              <i />
              <span>{s.label}</span>
            </button>
          ))}
          <button type="button" className={`wr-hold${tour.paused ? " is-on" : ""}`} aria-pressed={tour.paused} onClick={toggleHold}>
            {tour.paused ? "Resume tour" : "Hold wide"}
          </button>
          {full?.active ? (
            <button type="button" className={`wr-hold wr-full${full.active ? " is-on" : ""}`} aria-pressed={full.active} onClick={full.toggle}>
              {full.active ? "Exit full screen" : "Full screen"}
            </button>
          ) : null}
        </nav>
      </footer>
    </div>
  );
}

type Room = ReturnType<typeof useLiveRoom>;

function isLive(id: StopId, room: Room): boolean {
  if (id === "chief") return room.chief.state === "working";
  const t = TEAMS.find((x) => x.id === id);
  return !!t && room.teams[t.id].state === "working";
}

function captionFor(id: StopId, fallback: string, room: Room): string {
  if (id === "room") return room.working ? `${room.working} ${room.working === 1 ? "agent" : "agents"} working right now.` : fallback;
  if (id === "chief") return room.chief.state === "working" && room.chief.label ? `${CHIEF_NAME}: ${room.chief.label}` : fallback;
  const team = TEAMS.find((t) => t.id === id);
  if (!team) return fallback;
  const t = room.teams[team.id];
  if (t.state === "working" && t.label) return `${t.name}: ${t.label}`;
  if (t.state === "waiting") return `${t.name} is waiting on you.`;
  return fallback;
}

function roomLabel(room: Room): string {
  const busy = TEAMS.filter((t) => room.teams[t.id].state === "working").map((t) => room.teams[t.id].name);
  return busy.length ? `The worker room. Working now: ${busy.join(", ")}.` : "The worker room. Your agents are between tasks.";
}

