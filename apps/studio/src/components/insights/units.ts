import { fmtCompact, fmtPct, fmtUsd, fmtX } from "@/components/content/format";

/** Unit-aware number formatting, shared by server views and client charts (charts get a unit, not a function). */
export type Unit = "count" | "rate" | "x" | "per1k" | "usd" | "number" | "seconds";

export function fmtUnit(v: number | null | undefined, unit: Unit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  switch (unit) {
    case "count":
      return fmtCompact(Math.round(v));
    case "rate":
      return fmtPct(v, v < 0.01 ? 2 : 1);
    case "x":
      return fmtX(v);
    case "per1k":
      return v.toFixed(1);
    case "seconds":
      return `${v.toFixed(1)}s`;
    case "usd":
      return fmtUsd(v, { cents: false });
    default:
      return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
}

const compactAxis = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Axis ticks: one consistent style per axis (all compact once any tick reaches 10,000). */
export function fmtAxis(v: number, unit: Unit, maxTick: number): string {
  if (unit === "count" && maxTick >= 10_000) return compactAxis.format(v);
  if (unit === "rate") return fmtPct(v, maxTick < 0.05 ? 1 : 0);
  return fmtUnit(v, unit);
}

export const RANGE_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];
