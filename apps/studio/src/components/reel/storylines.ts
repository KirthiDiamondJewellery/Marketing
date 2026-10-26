/**
 * Scripted "day in the life" for reel mode: injected as synthetic live events so every surface has something to show on
 * camera. Deliberately business-neutral (no trade, brand or real numbers). Plain language only: show the work, not the
 * wiring.
 */
export type ReelStep =
  | { at: number; kind: "progress"; agent: string; message: string }
  | { at: number; kind: "handoff"; agent: string; to: string; message: string; job: string }
  | { at: number; kind: "approval"; agent: string; approval: "script" | "edit" | "post" | "dm_reply" | "campaign"; summary: string; message: string; preview: Record<string, unknown> }
  | { at: number; kind: "post"; agent: string; platforms: string[]; title: string; caption: string; minutesOut: number; message: string }
  | { at: number; kind: "cost"; agent: string; usd: number; message: string };

export type ReelStory = { id: string; agent: string; job: string; duration: number; steps: ReelStep[] };

export const STORYLINES: ReelStory[] = [
  {
    id: "outliers",
    agent: "analyst",
    job: "research.competitor-scan",
    duration: 20,
    steps: [
      { at: 1.5, kind: "progress", agent: "analyst", message: "Scanning 6 creators for outliers" },
      { at: 6, kind: "progress", agent: "analyst", message: "Found 2 posts at 3.4× their usual" },
      { at: 10, kind: "progress", agent: "analyst", message: "Pulled the hook and first 3 seconds of each" },
      { at: 12, kind: "cost", agent: "analyst", usd: 0.12, message: "Spent $0.12 on research" },
      { at: 13.5, kind: "handoff", agent: "analyst", to: "strategist", job: "strategy.daily-brief", message: "Analyst → Strategist: 2 outliers worth a remix" },
      { at: 16.5, kind: "progress", agent: "strategist", message: "Checking both outliers against this month's lanes" },
    ],
  },
  {
    id: "brief",
    agent: "strategist",
    job: "strategy.daily-brief",
    duration: 21,
    steps: [
      { at: 1.5, kind: "progress", agent: "strategist", message: "Read the lanes, the funnel mix and last week's results" },
      { at: 6, kind: "progress", agent: "strategist", message: "Picked the client before-and-after for Thursday" },
      { at: 9, kind: "handoff", agent: "strategist", to: "copywriter", job: "scripting.write-script", message: "Strategist → Copywriter: brief for the before-and-after" },
      { at: 12, kind: "progress", agent: "copywriter", message: "Drafting 3 hooks in the brand voice" },
      { at: 16, kind: "progress", agent: "copywriter", message: "Checked every claim against your proof file" },
      {
        at: 19,
        kind: "approval",
        agent: "copywriter",
        approval: "script",
        summary: "Script: \"What changed in 30 days\"",
        message: "Script ready for your approval",
        preview: { hook: "What changed in 30 days.", keyword: "RESULTS" },
      },
    ],
  },
  {
    id: "edit",
    agent: "copywriter",
    job: "scripting.write-script",
    duration: 20,
    steps: [
      { at: 1.5, kind: "progress", agent: "copywriter", message: "Tightened the FAQ script to 32 seconds" },
      { at: 5, kind: "handoff", agent: "copywriter", to: "art_director", job: "editing.prep", message: "Copywriter → Art Director: script for the FAQ reel" },
      { at: 8, kind: "progress", agent: "art_director", message: "Cutting the FAQ reel to 32 seconds" },
      { at: 12, kind: "progress", agent: "art_director", message: "Added captions in the brand type" },
      { at: 15.5, kind: "progress", agent: "art_director", message: "Quality check passed: clean audio, no dead air" },
      {
        at: 18.5,
        kind: "approval",
        agent: "art_director",
        approval: "edit",
        summary: "FAQ reel, version 1: 32 seconds, captions on",
        message: "FAQ reel ready for review",
        preview: { duration_s: 32, version: 1 },
      },
    ],
  },
  {
    id: "schedule",
    agent: "art_director",
    job: "editing.revise",
    duration: 20,
    steps: [
      { at: 1.5, kind: "progress", agent: "art_director", message: "Exported the mistakes reel in 9:16 and 4:5" },
      { at: 4.5, kind: "handoff", agent: "art_director", to: "publisher", job: "publishing.schedule", message: "Art Director → Publisher: final cut of the mistakes reel" },
      { at: 8, kind: "progress", agent: "publisher", message: "Picked the best slots this week for Instagram and TikTok" },
      {
        at: 12,
        kind: "post",
        agent: "publisher",
        platforms: ["instagram", "tiktok"],
        title: "Three mistakes that cost new clients a month",
        caption: "Three mistakes that cost new clients a month. Comment CHECKLIST for the free checklist.",
        minutesOut: 3,
        message: "Scheduled the mistakes reel on 2 platforms",
      },
      { at: 16, kind: "progress", agent: "publisher", message: "Checked links and captions on both platforms" },
    ],
  },
  {
    id: "community",
    agent: "community",
    job: "community.dm-triage",
    duration: 20,
    steps: [
      { at: 1.5, kind: "progress", agent: "community", message: "Read 23 new comments and 4 DMs" },
      { at: 5.5, kind: "progress", agent: "community", message: "Replied to 9 questions about availability" },
      { at: 9.5, kind: "progress", agent: "community", message: "1 hot lead: someone asking about your main offer" },
      { at: 12.5, kind: "handoff", agent: "community", to: "chief_of_staff", job: "ops.morning-brief", message: "Community → Chief of Staff: 1 hot lead for your inbox" },
      {
        at: 16,
        kind: "approval",
        agent: "community",
        approval: "dm_reply",
        summary: "Reply to an enquiry about your main offer",
        message: "Reply to a hot lead needs your approval",
        preview: { reply: "Happy to help. Evenings work for us. Would Tuesday at 6 suit you?" },
      },
    ],
  },
  {
    id: "brief-out",
    agent: "chief_of_staff",
    job: "ops.morning-brief",
    duration: 18,
    steps: [
      { at: 1.5, kind: "progress", agent: "chief_of_staff", message: "Pulled overnight results from every agent" },
      { at: 6, kind: "handoff", agent: "chief_of_staff", to: "strategist", job: "strategy.daily-brief", message: "Chief of Staff → Strategist: move the client story to Friday" },
      { at: 9.5, kind: "progress", agent: "strategist", message: "Moved the client story to Friday morning" },
      { at: 13, kind: "progress", agent: "chief_of_staff", message: "Sent you the daily brief: 3 posts out, 2 need you" },
    ],
  },
  {
    id: "measure",
    agent: "analyst",
    job: "learn.post-mortem",
    duration: 20,
    steps: [
      { at: 1.5, kind: "progress", agent: "analyst", message: "Pulled 24-hour numbers for yesterday's reel" },
      { at: 5.5, kind: "progress", agent: "analyst", message: "Side-by-side comparison: 2.1× your usual saves" },
      { at: 9, kind: "handoff", agent: "analyst", to: "strategist", job: "strategy.daily-brief", message: "Analyst → Strategist: comparison hooks are working" },
      { at: 12.5, kind: "progress", agent: "strategist", message: "Added two comparison hooks to next week" },
      { at: 15.5, kind: "progress", agent: "analyst", message: "Saved 2 lessons for the team" },
    ],
  },
  {
    id: "carousel",
    agent: "strategist",
    job: "strategy.daily-brief",
    duration: 22,
    steps: [
      { at: 1.5, kind: "progress", agent: "strategist", message: "Turning the pricing story into a carousel" },
      { at: 4.5, kind: "handoff", agent: "strategist", to: "art_director", job: "editing.prep", message: "Strategist → Art Director: 7-slide carousel on pricing" },
      { at: 8.5, kind: "progress", agent: "art_director", message: "Laid out 7 slides on the brand grid" },
      { at: 12, kind: "handoff", agent: "art_director", to: "publisher", job: "publishing.schedule", message: "Art Director → Publisher: carousel ready for Thursday" },
      {
        at: 15.5,
        kind: "post",
        agent: "publisher",
        platforms: ["instagram", "linkedin"],
        title: "What you actually pay for, in 7 slides",
        caption: "Seven things that go into the price, and the one that matters most. Comment PRICE for the breakdown.",
        minutesOut: 5,
        message: "Scheduled the carousel on 2 platforms",
      },
      { at: 19, kind: "progress", agent: "publisher", message: "Queue is set through Thursday" },
    ],
  },
];
