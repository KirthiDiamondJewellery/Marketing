import { FUNNEL_LABEL, humanize } from "@/components/content/format";

export const DIMENSION_LABEL: Record<string, string> = {
  hook_pattern: "Hook pattern",
  lane: "Lane",
  format: "Format",
  funnel_stage: "Funnel stage",
  cta_type: "Call to action",
  length_bucket: "Length",
  slot: "Posting time",
  story_structure: "Story structure",
  angle: "Angle",
};

/** Plain words for one value of a dimension ("18:30" → "6:30 PM", "tofu" → "Top of funnel"). */
export function valueLabel(dimension: string, value: string): string {
  if (dimension === "funnel_stage") return FUNNEL_LABEL[value] ?? humanize(value);
  if (dimension === "slot") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (m) {
      const h = Number(m[1]);
      return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
    }
  }
  if (dimension === "length_bucket") return value.replace("-", "–");
  if (dimension === "angle") return value;
  return humanize(value);
}

/** Lowercase phrase for sentences ("contrarian claim hooks", "the cost reality lane"). */
export function featurePhrase(dimension: string, value: string): string {
  const v = valueLabel(dimension, value).replace(/^the\s+/i, "");
  switch (dimension) {
    case "hook_pattern":
      return `${v.toLowerCase()} hooks`;
    case "lane":
      return `the ${v.toLowerCase()} lane`;
    case "format":
      return `the ${v.toLowerCase()} format`;
    case "cta_type":
      return `${v.toLowerCase()} calls to action`;
    case "slot":
      return `posts at ${v}`;
    case "length_bucket":
      return `${v} videos`;
    case "story_structure":
      return `the ${v.toLowerCase()} structure`;
    case "angle":
      return `the "${v.replace(/^the\s+/i, "").toLowerCase()}" angle`;
    case "funnel_stage":
      return `${v.toLowerCase()} posts`;
    default:
      return v.toLowerCase();
  }
}

/** Lowercase a value label for use mid-sentence, keeping times like "12:00 PM" intact. */
export function inlineValue(dimension: string, value: string): string {
  const v = valueLabel(dimension, value);
  return dimension === "slot" ? v : v.toLowerCase();
}
