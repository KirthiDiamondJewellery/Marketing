/**
 * Lead-magnet guide house format (skill: lead-magnet-guide). One guide per keyword, solving one narrow problem
 * completely. These checks are deterministic and run when a guide body is registered; errors block, warnings inform.
 */

export type GuideCheck = { ok: boolean; errors: string[]; warnings: string[]; slug: string };

export function slugify(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-");
}

export function checkGuide(markdown: string, opts: { keyword: string; title: string }): GuideCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const md = markdown.replace(/\r\n/g, "\n");
  const h1 = md.match(/^# (.+)$/m)?.[1]?.trim();
  if (!h1) errors.push('The guide needs a title line starting with "# ".');
  const h2 = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
  if (!h2.some((h) => h.startsWith("what's inside") || h.startsWith("what’s inside") || h.startsWith("what is inside"))) {
    errors.push('Add a "## What\'s inside" section with 4 bullets, so readers know what they get before the email gate.');
  } else {
    const inside = md.split(/^## /m).find((s) => /^what(’|')?s inside|^what is inside/i.test(s));
    const bullets = (inside?.match(/^\s*[-*] .+$/gm) ?? []).length;
    if (bullets !== 4) warnings.push(`"What's inside" has ${bullets} bullet${bullets === 1 ? "" : "s"}; the house format uses 4.`);
  }
  if (h2.length < 3) errors.push("The guide needs at least 3 sections (## headings): what's inside, the steps, and what to do next.");
  if (!/<!--\s*CTA\s*-->/.test(md)) warnings.push("Add one mid-guide call to action at a <!--CTA--> marker.");
  if (/[—–]/.test(md)) warnings.push("The guide has long dashes; the house style avoids them.");
  if (/\b[A-Z]{5,}\b/.test(md.replace(new RegExp(`\\b${opts.keyword.toUpperCase()}\\b`, "g"), ""))) warnings.push("Avoid ALL CAPS words in the guide.");
  const headings = [...md.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]!.trim());
  const titleCase = (h: string) => {
    const words = h.split(/\s+/).slice(1).filter((w) => w.length >= 4);
    return words.length >= 2 && words.every((w) => /^[A-Z][a-z]/.test(w));
  };
  if (headings.some(titleCase)) warnings.push("Use sentence case for headings (only the first word capitalised).");
  if (!new RegExp(`\\b${opts.keyword}\\b`, "i").test(md) && h1 && !new RegExp(opts.keyword, "i").test(h1)) {
    warnings.push(`The guide never mentions its keyword "${opts.keyword}"; readers who commented it should recognise they're in the right place.`);
  }
  return { ok: errors.length === 0, errors, warnings, slug: slugify(h1 ?? opts.title) };
}
