import { decideApproval, listApprovals, type ApprovalDecision } from "@attentionos/db";
import { parseCommand } from "../args.ts";
import { UserError } from "../errors.ts";
import { ui } from "../ui.ts";
import { openWorkspace, type CliContext } from "../workspace.ts";

const DECISIONS: Record<string, ApprovalDecision> = { approve: "approved", reject: "rejected", revise: "revised" };

export const APPROVALS_HELP = `See and decide what's waiting for your approval.

Usage
  attentionos approvals                              List what's waiting
  attentionos approvals approve <ref> [--note "…"]   e.g. attentionos approvals approve ap-12
  attentionos approvals reject <ref> --note "…"
  attentionos approvals revise <ref> --note "…"      Ask for changes
`;

export async function runApprovals(argv: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand("approvals", argv, { note: { type: "string", short: "n" }, all: { type: "boolean", default: false } });
  if (values.help) {
    ui.out(APPROVALS_HELP);
    return 0;
  }
  const [action, ref] = positionals;
  if (action && action !== "list" && !DECISIONS[action]) throw new UserError(`Unknown action "${action}".`, "Use approve, reject or revise, e.g. attentionos approvals approve ap-12");
  if (action && action !== "list" && !ref) throw new UserError(`Which approval? Add its ref, e.g. attentionos approvals ${action} ap-12`);
  const { ws } = await openWorkspace(ctx, { providers: false });
  try {
    if (!action || action === "list") {
      const rows = await listApprovals(ws.sql, ws.id, { status: values.all ? "all" : "pending", limit: 50 });
      ui.title(rows.length ? `${rows.length} waiting for you` : "Nothing is waiting for you");
      for (const a of rows) ui.out(`  ${ui.bold(a.ref.padEnd(6))} ${a.summary} ${ui.dim(`· ${a.kind} · ${a.agent}${a.status !== "pending" ? ` · ${a.status}` : ""}`)}`);
      ui.out();
      return 0;
    }
    const decision = DECISIONS[action]!;
    const note = values.note as string | undefined;
    if (decision !== "approved" && !note) throw new UserError("Add a short note so the agent knows what to change.", `attentionos approvals ${action} ${ref} --note "Shorter hook"`);
    const row = await decideApproval(ws.sql, ws.id, { refOrId: ref!, decision, note, actor: "user:local" });
    ui.ok(`${decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Asked for changes on"} ${row.ref}`, row.summary);
    if (note && decision !== "approved") ui.out(ui.dim("  Tip: if this is a lasting preference, tell Claude Code to save it as a lesson."));
    return 0;
  } finally {
    await ws.close();
  }
}
