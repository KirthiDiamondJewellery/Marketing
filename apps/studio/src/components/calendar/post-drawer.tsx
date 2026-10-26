"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, X } from "lucide-react";
import { GoLiveBurst } from "@/motion/GoLiveBurst";
import { Button, Input } from "@/components/ui";
import type { CalendarPost } from "@/server/queries/calendar";
import { cancelPostsAction, markPostLiveAction } from "@/server/actions/calendar";
import { cancelTrialReelsAction, confirmTrialProofAction } from "@/server/actions/trial-reels";
import { PlatformIcon, StatusDot, ThumbPlaceholder } from "@/components/content/shared";
import { toast } from "@/components/content/toast";
import { fmtCompact, fmtDateTime, fmtRelative, fmtX, platformLabel, zonedParts, zonedToUtc } from "@/components/content/format";
import { MOVABLE, statusWords, type PostGroup } from "./group";

/**
 * The post drawer: what is going out, where, and when. Move it, cancel it, or open the live post. A post that goes
 * live while the drawer is open plays the publish burst.
 */
export function PostDrawer({
  group,
  tz,
  burst,
  onBurstDone,
  onClose,
  onReschedule,
}: {
  group: PostGroup | null;
  tz: string;
  burst: string[] | null;
  onBurstDone: () => void;
  onClose: () => void;
  onReschedule: (group: PostGroup, at: Date) => Promise<void>;
}) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!group) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group, onClose]);

  return (
    <AnimatePresence>
      {group ? (
        <>
          <motion.div
            key="scrim"
            className="fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--bg)_55%,transparent)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2 }}
            onClick={onClose}
          />
          <motion.aside
            key="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={group.title}
            className="fixed inset-x-0 bottom-0 z-50 max-h-[88vh] overflow-y-auto rounded-t-xl border border-border bg-surface-2 shadow-[var(--shadow-3)] md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[440px] md:rounded-none md:rounded-l-xl"
            initial={{ opacity: 0, x: reduce ? 0 : 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduce ? 0 : 16 }}
            transition={{ duration: reduce ? 0 : 0.32, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <DrawerBody group={group} tz={tz} burst={burst} onBurstDone={onBurstDone} onClose={onClose} onReschedule={onReschedule} />
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

function DrawerBody({
  group,
  tz,
  burst,
  onBurstDone,
  onClose,
  onReschedule,
}: {
  group: PostGroup;
  tz: string;
  burst: string[] | null;
  onBurstDone: () => void;
  onClose: () => void;
  onReschedule: (group: PostGroup, at: Date) => Promise<void>;
}) {
  const movable = group.posts.filter((p) => MOVABLE.has(p.status));
  return (
    <div className="flex flex-col gap-7 p-6">
      <div className="flex items-start gap-4">
        <div className="h-[96px] w-[54px] shrink-0 overflow-hidden rounded-md border border-border">
          {group.thumbId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/media/${group.thumbId}`} alt="" className="size-full object-cover" />
          ) : (
            <ThumbPlaceholder className="size-full" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-small text-fg-2">{fmtDateTime(group.at, tz)}</p>
          <h2 className="mt-1 text-h2 font-medium text-fg">{group.title}</h2>
        </div>
        <button type="button" onClick={onClose} className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      {burst ? (
        <div className="rounded-lg border border-border bg-surface-1 p-5">
          <GoLiveBurst platforms={burst} play onDone={onBurstDone} />
        </div>
      ) : null}

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
        {group.posts.map((p) => (
          <PostRow key={p.id} post={p} tz={tz} />
        ))}
      </ul>

      {group.trial ? <TrialCancel group={group} onDone={onClose} /> : movable.length ? <Reschedule group={group} tz={tz} onReschedule={onReschedule} onDone={onClose} /> : null}
    </div>
  );
}

function PostRow({ post, tz }: { post: CalendarPost; tz: string }) {
  const st = statusWords(post.status);
  const m = post.metrics;
  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <PlatformIcon platform={post.platform} label className="text-fg" />
        <StatusDot tone={st.tone} label={st.label} className="ml-auto" />
      </div>
      {post.trial ? <p className="text-caption text-fg-3">Trial reel: shown to people who don't follow you yet, never on your grid.</p> : null}
      {post.caption ? <p className="line-clamp-4 whitespace-pre-line text-small text-fg-2">{post.caption}</p> : null}
      {post.trialProofNeeded ? <TrialProof post={post} /> : null}
      {post.status === "failed" ? <p className="text-small text-danger">{post.error ? `Why: ${post.error}` : "It didn't go out. Move it to a new time to try again."}</p> : null}
      {post.status === "assist" ? (
        <>
          <p className="text-caption text-fg-3">
            You post this one yourself so you can add trending audio. At post time you get a reminder with the video and the caption ready to paste.
          </p>
          <MarkLive post={post} />
        </>
      ) : null}
      {post.status === "published" && m ? (
        <p className="text-caption text-fg-2 tabular">
          {[m.views !== null ? `${fmtCompact(m.views)} views` : null, m.saves !== null ? `${fmtCompact(m.saves)} saves` : null, m.comments !== null ? `${fmtCompact(m.comments)} comments` : null, m.x !== null ? `${fmtX(m.x)} your usual` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-fg-3">
        {post.status === "published" ? <span>Posted {fmtRelative(post.at)}</span> : <span>{fmtDateTime(post.at, tz)}</span>}
        {post.url ? (
          <a href={post.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-fg-2 hover:text-fg">
            View on {platformLabel(post.platform)} <ArrowUpRight className="size-3" />
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** The one-time check per account: the first live trial reel must not be on the grid before full days go out. */
function TrialProof({ post }: { post: CalendarPost }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning/40 p-3">
      <p className="text-small text-fg-2">First trial reel on this account. Open your profile: if this one is <span className="text-fg">not</span> on your grid, confirm it so the rest of your trial reels can go out.</p>
      <Button
        size="sm"
        variant="primary"
        className="self-start"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await confirmTrialProofAction(post.id);
            if (res.ok) {
              toast(res.message ?? "Confirmed.", { by: "Publisher" });
              router.refresh();
            } else toast(res.error, { tone: "error" });
          })
        }
      >
        {pending ? "Saving…" : "It stayed off my grid"}
      </Button>
    </div>
  );
}

function TrialCancel({ group, onDone }: { group: PostGroup; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const ids = group.posts.filter((p) => MOVABLE.has(p.status) || p.status === "publishing").map((p) => p.id);
  if (!ids.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <p className="text-small text-fg-2">Trial reel times come from the day's plan, so they aren't moved one by one.</p>
      <Button
        size="sm"
        variant="ghost"
        className="-ml-3 self-start text-fg-3"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await cancelTrialReelsAction({ postIds: ids });
            if (res.ok) {
              toast(res.message ?? "Cancelling.", { by: "Publisher" });
              onDone();
              router.refresh();
            } else toast(res.error, { tone: "error" });
          })
        }
      >
        {pending ? "Cancelling…" : "Cancel this trial reel"}
      </Button>
    </section>
  );
}

function MarkLive({ post }: { post: CalendarPost }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button size="sm" variant="secondary" className="self-start" onClick={() => setOpen(true)}>
        I posted it
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await markPostLiveAction(post.id, url);
          if (res.ok) {
            toast(res.message, { by: "Publisher" });
            router.refresh();
          } else toast(res.error, { tone: "error" });
        });
      }}
    >
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Post link (optional)" aria-label="Post link" className="sm:flex-1" />
      <Button type="submit" size="md" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Mark as posted"}
      </Button>
    </form>
  );
}

function toLocalInput(iso: string, tz: string): string {
  const p = zonedParts(iso, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

function Reschedule({ group, tz, onReschedule, onDone }: { group: PostGroup; tz: string; onReschedule: (group: PostGroup, at: Date) => Promise<void>; onDone: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState(() => toLocalInput(group.at, tz));
  const [pending, start] = useTransition();
  const [cancelling, startCancel] = useTransition();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setValue(toLocalInput(group.at, tz)), [group.at, tz]);
  const changed = value !== toLocalInput(group.at, tz);
  const ids = group.posts.filter((p) => MOVABLE.has(p.status)).map((p) => p.id);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-h3 font-medium text-fg">Change the time</h3>
      <p className="text-small text-fg-2">Times are in {tz.replace(/_/g, " ")}. You can also drag it on the calendar.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="datetime-local"
          value={value}
          step={900}
          onChange={(e) => setValue(e.target.value)}
          className="h-10 w-full rounded-sm border border-border bg-surface-1 px-3 text-[15px] text-fg outline-none [color-scheme:dark] focus:border-brand focus:shadow-[0_0_0_3px_var(--brand-tint)] sm:flex-1"
          aria-label="New time"
        />
        <Button
          variant="primary"
          disabled={!changed || pending}
          onClick={() => {
            const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
            if (!m) return;
            const at = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
            start(() => onReschedule(group, at));
          }}
          className="h-10"
        >
          {pending ? "Moving…" : "Move it"}
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {confirm ? (
          <>
            <span className="text-small text-fg-2">Cancel {ids.length === 1 ? "this post" : `these ${ids.length} posts`}?</span>
            <Button
              size="sm"
              variant="danger"
              disabled={cancelling}
              onClick={() =>
                startCancel(async () => {
                  const res = await cancelPostsAction(ids);
                  if (res.ok) {
                    toast(res.message, { by: "Publisher" });
                    onDone();
                    router.refresh();
                  } else {
                    toast(res.error, { tone: "error" });
                    setConfirm(false);
                  }
                })
              }
            >
              {cancelling ? "Cancelling…" : "Yes, cancel"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="-ml-3 text-fg-3" onClick={() => setConfirm(true)}>
            Cancel {ids.length === 1 ? "post" : "posts"}
          </Button>
        )}
      </div>
    </section>
  );
}
