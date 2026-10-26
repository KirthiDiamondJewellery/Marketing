"use server";
import { revalidatePath } from "next/cache";
import { requireSession, UnauthorizedError } from "@/server/auth";
import { runStudioDoctor, type DoctorReport } from "@/server/doctor";
import { applyConfigEdits, KNOWN_KEYS, validateSetting, writeEnvKey, type ConfigEdit } from "@/server/settings";
import { appliedNote, settingsApplyLive } from "@/server/live-settings";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, parse } from "@/server/validate";

/** `applying`: AttentionOS is restarting Studio and the worker with the new settings (the live stream drops briefly). */
export type SettingsResult = { ok: true; message: string; applying?: boolean } | { ok: false; error: string };

/** Each value is checked against the settings it may change by `validateSetting`, so it stays `unknown` here. */
const settingsEdits = z.array(z.object({ path: z.string().max(200), value: z.unknown() })).max(20);
const keyInput = z.object({ name: z.string().max(100), value: z.string() });

function denied(e: unknown): { ok: false; error: string } | null {
  return e instanceof UnauthorizedError ? { ok: false, error: e.message } : null;
}

/** Saves one or more simple settings into config/attentionos.config.ts (validated before the file is replaced). */
export async function saveSettingsAction(edits: { path: string; value: unknown }[]): Promise<SettingsResult> {
  try {
    await requireSession();
  } catch (e) {
    return denied(e) ?? { ok: false, error: "Not allowed." };
  }
  const list = parse(settingsEdits, edits);
  if (!list) return { ok: false, error: BAD_REQUEST };
  if (list.length === 0) return { ok: false, error: "Nothing to save." };
  const clean: ConfigEdit[] = [];
  for (const e of list) {
    const v = validateSetting(e.path, e.value);
    if (!v.ok) return { ok: false, error: v.error };
    clean.push({ path: v.path, value: v.value });
  }
  try {
    const res = await applyConfigEdits(workspace().root, clean);
    if (!res.ok) return { ok: false, error: res.error };
  } catch (err) {
    console.error("[studio] saving settings failed:", err);
    return { ok: false, error: "Couldn't save the settings file. Check that Studio can write to your workspace folder." };
  }
  revalidatePath("/settings");
  if (settingsApplyLive()) return { ok: true, message: "Saved. Applying your settings…", applying: true };
  return { ok: true, message: `Saved to config/attentionos.config.ts. ${appliedNote()}` };
}

/** Writes one connection key to the workspace .env. The value is never sent back to the browser. */
export async function saveKeyAction(name: string, value: string): Promise<SettingsResult> {
  try {
    await requireSession();
  } catch (e) {
    return denied(e) ?? { ok: false, error: "Not allowed." };
  }
  const args = parse(keyInput, { name, value });
  if (!args) return { ok: false, error: "Paste the key first." };
  const key = KNOWN_KEYS.find((k) => k.name === args.name);
  if (!key?.editable) return { ok: false, error: "Studio can't set that key. Edit .env by hand." };
  const v = args.value.trim();
  if (!v || v.length > 4096) return { ok: false, error: "Paste the key first." };
  try {
    writeEnvKey(workspace().root, args.name, v);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't write .env." };
  }
  revalidatePath("/settings");
  if (settingsApplyLive()) return { ok: true, message: "Saved. Applying your settings…", applying: true };
  return { ok: true, message: `Saved ${args.name} to .env. ${appliedNote()}` };
}

export async function runDoctorAction(): Promise<{ ok: true; report: DoctorReport } | { ok: false; error: string }> {
  try {
    await requireSession();
  } catch (e) {
    return denied(e) ?? { ok: false, error: "Not allowed." };
  }
  try {
    return { ok: true, report: await runStudioDoctor() };
  } catch (err) {
    console.error("[studio] doctor failed:", err);
    return { ok: false, error: "The checks couldn't run. Try `./aos doctor` from your AttentionOS folder." };
  }
}
