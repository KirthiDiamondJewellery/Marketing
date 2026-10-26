import { z } from "zod";
import { IssueCollector, tokenize, type ValidationResult } from "@attentionos/guardrails";
import { HOOK_PATTERN_IDS } from "./taxonomy.ts";

/**
 * Output contract for the tool-less hook classifier (`scripting.classify-hooks`). Harvested hooks are
 * untrusted text, so the model only sees them in a tool-less call and its output is validated here
 * before anything is written.
 *
 * The model returns, per hook, a taxonomy pattern and an ABSTRACT: the hook's structure with the words
 * replaced by [placeholders]. Tool-using agents only ever see the abstract of a competitor hook, so
 * structure carries over and words never do.
 */

export const classificationItemSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1),
  abstract: z.string().min(8).max(160),
});
export const classificationOutputSchema = z.object({ items: z.array(classificationItemSchema) });
/** What the runner should accept from the model: items are checked one by one by validateClassification. */
export const classificationEnvelopeSchema = z.object({ items: z.array(z.unknown()) });
export type ClassificationOutput = z.output<typeof classificationOutputSchema>;

/** Longest run of consecutive words two texts share. */
export function sharedRun(a: string, b: string): number {
  const wa = tokenize(a.toLowerCase()).map((t) => t.word);
  const wb = tokenize(b.toLowerCase()).map((t) => t.word);
  let best = 0;
  for (let i = 0; i < wa.length; i++) {
    for (let j = 0; j < wb.length; j++) {
      let k = 0;
      while (i + k < wa.length && j + k < wb.length && wa[i + k] === wb[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/**
 * Validates classifier output against the hooks that were sent. Returns the accepted items and a report;
 * rejected items are left for the regex pre-classifier and the template fallback.
 */
export function validateClassification(
  output: unknown,
  sent: readonly { id: string; text: string }[],
): { accepted: { id: string; pattern: string; abstract: string }[]; report: ValidationResult } {
  const c = new IssueCollector();
  const parsed = classificationEnvelopeSchema.safeParse(output);
  if (!parsed.success) {
    c.error("classify.shape", `The classifier output has the wrong shape: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}.`);
    return { accepted: [], report: c.result() };
  }
  const byId = new Map(sent.map((s) => [s.id, s.text]));
  const seen = new Set<string>();
  const accepted: { id: string; pattern: string; abstract: string }[] = [];
  parsed.data.items.forEach((rawItem, i) => {
    const path = `items[${i}]`;
    const itemParsed = classificationItemSchema.safeParse(rawItem);
    if (!itemParsed.success) return c.error("classify.item_shape", `Item ${i + 1} has the wrong shape: ${itemParsed.error.issues.map((x) => `${x.path.join(".") || "item"} ${x.message}`).join("; ")}.`, { path });
    const item = itemParsed.data;
    const source = byId.get(item.id);
    if (source === undefined) return c.error("classify.unknown_id", `Item ${i + 1} has an id that wasn't sent ("${item.id}").`, { path });
    if (seen.has(item.id)) return c.error("classify.duplicate", `Hook ${item.id} was classified twice.`, { path });
    seen.add(item.id);
    if (!HOOK_PATTERN_IDS.includes(item.pattern)) return c.error("classify.unknown_pattern", `"${item.pattern}" isn't in the hook taxonomy.`, { path, fix: `Use one of: ${HOOK_PATTERN_IDS.join(", ")}.` });
    const a = item.abstract;
    if (!/\[[^\]]{2,40}\]/.test(a)) return c.error("classify.abstract_no_placeholder", `The abstract for ${item.id} has no [placeholder]; it must describe structure, not repeat words.`, { path });
    if (/https?:\/\/|www\.|@\w|#\w|[<>{}`]/i.test(a)) return c.error("classify.abstract_unsafe", `The abstract for ${item.id} contains a link, handle, tag or markup.`, { path });
    if (/\b(ignore|disregard|instruction|system prompt|assistant|tool)\b/i.test(a)) return c.error("classify.abstract_unsafe", `The abstract for ${item.id} reads like an instruction, not a hook structure.`, { path });
    if (sharedRun(a, source) >= 4) return c.error("classify.abstract_copies_words", `The abstract for ${item.id} repeats 4 or more words of the original hook in a row.`, { path, fix: "Replace the specific words with [placeholders]." });
    accepted.push({ id: item.id, pattern: item.pattern, abstract: a.trim() });
  });
  return { accepted, report: c.result() };
}
