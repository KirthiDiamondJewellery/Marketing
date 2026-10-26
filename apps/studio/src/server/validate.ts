import { z } from "zod";

/**
 * Shared input schemas for Studio's server actions. Server actions are public endpoints: whatever the browser sends is
 * untrusted, so every action parses its arguments with Zod first and answers a bad request with a plain-language
 * error in its usual result shape. The schemas only check shape and size; the actions keep their own, friendlier
 * checks for values that are well-formed but not acceptable (an empty note, a time in the past).
 */

/** A database id. `z.guid()` accepts any 8-4-4-4-12 hex id, like Postgres does (no RFC version check). */
export const id = z.guid();

/** An approval id or its short ref (`ap-…`), as approval actions accept either. */
export const idOrRef = z.string().trim().min(1).max(64);

/** A short ref such as an edit's (`ed-…`). */
export const ref = z.string().trim().min(1).max(64);

/** A short machine key: an agent key, job id, platform, tier or status. */
export const key = z.string().min(1).max(100);

/** A social handle as typed (with or without @, or a profile link; the action cleans it up). */
export const handle = z.string().max(400);

/** Free text from a form field or note box; the cap is generous, actions apply their own limits. */
export const text = (max = 20_000) => z.string().max(max);

/** A list of ids, capped so one request can't ask for unbounded work. */
export const ids = (max = 200) => z.array(id).max(max);

/** A timestamp string the action will parse itself (ISO from the browser). */
export const isoTime = z.string().min(1).max(64);

/** Platform names keyed to captions or picked as targets; the actions filter to the platforms they know. */
export const platforms = z.array(z.string().max(32)).max(20);
export const captions = z.record(z.string().max(32), z.string().max(10_000));

/** Parses `input` with `schema`; `undefined` when it doesn't fit (the caller returns its own error shape). */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> | undefined {
  const r = schema.safeParse(input);
  return r.success ? r.data : undefined;
}

/** Plain-language fallback when a request doesn't have the shape an action expects. */
export const BAD_REQUEST = "That request didn't look right. Refresh the page and try again.";
