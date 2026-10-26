"use client";
import { BriefingFigure } from "@/motion/BriefingFigure";
import { fmtUnit, type Unit } from "./units";

/** The editorial headline figure (Sora, odometer roll-up) with unit-aware formatting. */
export function Figure({ value, unit, label, size = "xl" }: { value: number; unit: Unit; label: string; size?: "l" | "xl" }) {
  return <BriefingFigure value={value} format={(n) => fmtUnit(n, unit)} label={label} size={size} />;
}
