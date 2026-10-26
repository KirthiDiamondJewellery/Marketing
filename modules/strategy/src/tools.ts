import { z } from "zod";
import { jsonb, compact, defineTool, FUNNEL_STAGES, ToolError, type WorkspaceContext } from "@attentionos/core";
import { appendRejectedConcept, parsePillars, PROOF_KINDS } from "./pillars.ts";
import { briefFor, getContent, laneCountsSince, listIdeas, proofCandidates, recentPieces, todayLocal, weekStart, type BriefRow } from "./repo.ts";
import { strategySettings } from "./settings.ts";

const itemView = (ws: WorkspaceContext, r: BriefRow) => {
  const pillars = parsePillars(ws.brand().docs["pillars"]);
  const structure = pillars.storyStructures.find((s) => s.id === r.storyStructure);
  return compact({
    contentId: r.id,
    slot: r.brief.slot,
    kind: r.brief.kind,
    title: r.title,
    status: r.status === "idea" ? undefined : r.status,
    lane: r.brief.laneName ?? r.lane,
    funnelStage: r.funnelStage,
    angle: r.angle,
    storyStructure: structure ? `${structure.name}: ${structure.description}` : r.storyStructure,
    format: r.template,
    cta: r.ctaType,
    filmBy: r.filmBy,
    why: r.brief.why,
    proof: r.brief.proof,
    sources: r.sourceRefs,
    header: r.brief.header,
    hookIdea: r.brief.hookIdea,
    shootDirections: r.brief.shootDirections,
  });
};

export const getTodaysBriefTool = defineTool({
  name: "strategy_get_todays_brief",
  description:
    'The "Film today" brief (or the batch-day edition): every planned piece with its lane, funnel stage, angle, story structure, format, CTA, film-by deadline, ' +
    "why it was picked, proof numbers (the only numbers allowed) and sources. Run strategy.daily-brief first if it's empty.",
  input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), mode: z.enum(["daily", "batch"]).default("daily") }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const date = input.date ?? todayLocal(ws);
    const rows = await briefFor(ws, date, input.mode);
    if (rows.length === 0) return { date, mode: input.mode, items: [], note: "No brief for this date yet." };
    return { date, mode: input.mode, items: rows.map((r) => itemView(ws, r)) };
  },
});

const NUMBER_RE = /\d[\d,.]*%?/g;

export const saveBriefItemTool = defineTool({
  name: "strategy_save_brief_item",
  description:
    "Save the drafted header (on-screen, max 60 characters), a one-line hook idea and 2–4 shoot directions for one brief item. " +
    "Numbers are only accepted if they appear in the item's proof numbers or title; banned phrases from brand/brand.yaml are rejected.",
  input: z.object({
    contentId: z.string().uuid(),
    header: z.string().trim().min(3).max(60),
    hookIdea: z.string().trim().min(5).max(160),
    shootDirections: z.array(z.string().trim().min(3).max(200)).min(1).max(4),
  }),
  async handler({ ws, actor }, input) {
    const row = await getContent(ws, input.contentId);
    if (!row) throw new ToolError("No content with that id");
    const text = [input.header, input.hookIdea].join(" ");
    const lower = `${text} ${input.shootDirections.join(" ")}`.toLowerCase();
    const banned = ws.brand().brand.bannedPhrases.filter((p) => p.trim() && lower.includes(p.toLowerCase()));
    if (banned.length) throw new ToolError(`Uses banned phrase${banned.length === 1 ? "" : "s"}: ${banned.map((b) => `"${b}"`).join(", ")}`);
    const proof = row.brief.proof as { numbers?: { value: string }[] } | undefined;
    const allowed = new Set([...(proof?.numbers ?? []).flatMap((n) => n.value.match(NUMBER_RE) ?? []), ...(row.title.match(NUMBER_RE) ?? [])]);
    const invented = (text.match(NUMBER_RE) ?? []).filter((n) => !allowed.has(n));
    if (invented.length) {
      throw new ToolError(`Numbers must come from the proof inventory: ${invented.join(", ")} isn't in this item's proof`, "Remove the number or pick a proof item that has it (strategy_pick_proof_item)");
    }
    const patch = { header: input.header, hookIdea: input.hookIdea, shootDirections: input.shootDirections, draftedBy: actor, draftedAt: ws.now().toISOString() };
    await ws.sql`update content set brief = brief || ${jsonb(ws.sql, patch)}, updated_at = ${ws.now()} where workspace_id = ${ws.id} and id = ${row.id}`;
    return { saved: true, contentId: row.id };
  },
});

export const laneBalanceTool = defineTool({
  name: "strategy_get_lane_balance",
  description: "This week's lane quotas against what's planned or made, and the funnel mix (TOFU/MOFU/BOFU) over the last pieces against the brand's target. Use it to decide what's missing.",
  input: z.object({}),
  annotations: { readOnly: true },
  async handler({ ws }) {
    const s = strategySettings(ws);
    const kit = ws.brand();
    const pillars = parsePillars(kit.docs["pillars"]);
    const start = weekStart(ws.now(), ws.config.workspace.timezone);
    const counts = await laneCountsSince(ws, start);
    const recent = (await recentPieces(ws, s.funnelWindow)).map((r) => r.funnelStage).filter(Boolean);
    const actual = Object.fromEntries(FUNNEL_STAGES.map((f) => [f, recent.length ? Math.round((recent.filter((x) => x === f).length / recent.length) * 100) : 0]));
    return compact({
      weekStarting: start.toISOString(),
      lanes: pillars.lanes.map((l) => ({ id: l.id, name: l.name, funnelStage: l.funnelStage, quota: l.weeklyQuota, thisWeek: counts[l.id] ?? 0, left: Math.max(0, l.weeklyQuota - (counts[l.id] ?? 0)) })),
      funnel: { target: kit.brand.funnelMix, actual, overLast: recent.length },
      notes: [...pillars.problems, ...(pillars.fallbackLanes ? ["brand/pillars.md has no lanes yet; generic lanes are in use"] : [])],
    });
  },
});

export const listIdeasTool = defineTool({
  name: "strategy_list_ideas",
  description: "Content ideas waiting to be scripted (status idea), soonest film-by first. Filter by lane, or include other statuses.",
  input: z.object({
    lane: z.string().optional(),
    status: z.array(z.enum(["idea", "scripted", "filming", "editing", "review"])).default(["idea"]),
    limit: z.number().int().positive().max(50).default(20),
  }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const rows = await listIdeas(ws, input);
    return { count: rows.length, ideas: rows.map((r) => itemView(ws, r)) };
  },
});

export const rejectConceptTool = defineTool({
  name: "strategy_reject_concept",
  description:
    "Record that the user said no to an idea. It's added to the rejected concepts in brand/pillars.md (so it's never suggested again) and, when a contentId is given, the idea is archived.",
  input: z.object({
    contentId: z.string().uuid().optional(),
    concept: z.string().trim().min(3).max(200).optional().describe("Defaults to the idea's title"),
    why: z.string().trim().max(200).optional(),
  }),
  annotations: { destructive: true },
  async handler({ ws, actor }, input) {
    const row = input.contentId ? await getContent(ws, input.contentId) : null;
    if (input.contentId && !row) throw new ToolError("No content with that id");
    const concept = input.concept ?? row?.title;
    if (!concept) throw new ToolError("Say what the rejected concept is, or pass the idea's contentId");
    appendRejectedConcept(ws.paths.brand, { date: todayLocal(ws), text: concept, ...(input.why ? { why: input.why } : {}) });
    ws.reloadBrand();
    if (row) {
      await ws.sql`update content set status = 'archived', brief = brief || ${jsonb(ws.sql, { rejected: { why: input.why ?? null, by: actor, at: ws.now().toISOString() } })}, updated_at = ${ws.now()}
                   where workspace_id = ${ws.id} and id = ${row.id}`;
    }
    return { rejected: concept, archived: Boolean(row) };
  },
});

export const pickProofItemTool = defineTool({
  name: "strategy_pick_proof_item",
  description:
    "Pick the next proof item (case study, client win, FAQ, objection, process, build, story, stat) from brand/proof-inventory.yaml, rotating with a cooldown so the same proof isn't reused too soon. " +
    "Its numbers are the only numbers allowed in proof content. Pass attachTo to link it to an idea.",
  input: z.object({
    lane: z.string().optional().describe("Use the lane's proof kinds"),
    kind: z.enum(PROOF_KINDS).optional(),
    attachTo: z.string().uuid().optional(),
  }),
  async handler({ ws }, input) {
    const s = strategySettings(ws);
    const pillars = parsePillars(ws.brand().docs["pillars"]);
    const lane = input.lane ? pillars.lanes.find((l) => l.id === input.lane || l.name.toLowerCase() === input.lane!.toLowerCase()) : undefined;
    if (input.lane && !lane) throw new ToolError(`No lane "${input.lane}" in brand/pillars.md`);
    const kinds = input.kind ? [input.kind] : lane?.proofKinds.length ? lane.proofKinds : [...PROOF_KINDS];
    const proofDays = pillars.cooldowns.proofDays ?? s.cooldowns.proofDays;
    const now = ws.now().getTime();
    const all = (await proofCandidates(ws)).filter((p) => kinds.includes(p.kind));
    if (all.length === 0) throw new ToolError("No matching proof items", "Add case studies, wins, FAQs or objections to brand/proof-inventory.yaml");
    const sorted = [...all].sort((a, b) => (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0) - (b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0));
    const fresh = sorted.find((p) => !p.lastUsedAt || now - Date.parse(p.lastUsedAt) > proofDays * 86_400_000);
    const pick = fresh ?? sorted[0]!;
    if (input.attachTo) {
      const row = await getContent(ws, input.attachTo);
      if (!row) throw new ToolError("No content with that id to attach to");
      const proof = { id: pick.id, title: pick.title, numbers: pick.numbers, clientConsent: pick.clientConsent };
      await ws.sql`
        update content set source_refs = source_refs || ${jsonb(ws.sql, [{ type: "proof", id: pick.id }])},
                           brief = coalesce(brief, '{}'::jsonb) || ${jsonb(ws.sql, { proof })}, updated_at = ${ws.now()}
         where workspace_id = ${ws.id} and id = ${row.id}`;
    }
    return compact({
      ...pick,
      cooledDown: !fresh ? `Every matching item was used in the last ${proofDays} days; this is the least recently used.` : undefined,
      nameClient: pick.clientConsent ? undefined : "No consent to name this client: describe them without a name.",
      attachedTo: input.attachTo,
    });
  },
});

export const STRATEGY_TOOLS = [getTodaysBriefTool, saveBriefItemTool, laneBalanceTool, listIdeasTool, rejectConceptTool, pickProofItemTool];
