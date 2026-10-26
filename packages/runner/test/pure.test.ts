import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseConfig } from "@attentionos/core";
import { evaluateBudget, modelIdFor, parseJsonFromText, resolveModel, validateOutput } from "../src/index.ts";

describe("budget rule", () => {
  it("caps a run at the smallest of per-run, job and remaining daily budget", () => {
    expect(evaluateBudget({ spentTodayMicro: 0, dailyUsd: 5, perRunUsd: 2 })).toMatchObject({ ok: true, capUsd: 2 });
    expect(evaluateBudget({ spentTodayMicro: 0, dailyUsd: 5, perRunUsd: 2, jobBudgetUsd: 0.5 })).toMatchObject({ ok: true, capUsd: 0.5 });
    expect(evaluateBudget({ spentTodayMicro: 4_200_000, dailyUsd: 5, perRunUsd: 2 })).toMatchObject({ ok: true, capUsd: 0.8 });
  });

  it("refuses when today's budget is used up", () => {
    const d = evaluateBudget({ spentTodayMicro: 4_970_000, dailyUsd: 5, perRunUsd: 2 });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe("Today's AI budget is used up ($4.97 of $5.00).");
      expect(d.fix).toMatch(/budgets\.dailyUsd/);
    }
  });
});

describe("models", () => {
  it("maps aliases to configurable ids", () => {
    expect(modelIdFor("opus")).toBe("claude-opus-5");
    expect(modelIdFor("sonnet")).toBe("claude-sonnet-5");
    expect(modelIdFor("haiku")).toBe("claude-haiku-4-5");
    expect(modelIdFor("opus", (n) => (n === "ATTENTIONOS_MODEL_OPUS" ? "claude-opus-custom" : undefined))).toBe("claude-opus-custom");
    expect(modelIdFor("claude-some-exact-id")).toBe("claude-some-exact-id");
    expect(modelIdFor("sonnet", () => undefined, { sonnet: "claude-sonnet-next" })).toBe("claude-sonnet-next");
    expect(modelIdFor("sonnet", (n) => (n === "ATTENTIONOS_MODEL_SONNET" ? "env-wins" : undefined), { sonnet: "claude-sonnet-next" })).toBe("env-wins");
  });

  it("prefers the agent's model, then the job default, then sonnet", () => {
    const ws = { config: parseConfig({ agents: { copywriter: { model: "opus" } } }), secret: () => undefined };
    expect(resolveModel(ws, { agent: "copywriter", defaultModel: "haiku" })).toBe("claude-opus-5");
    expect(resolveModel(ws, { agent: "analyst", defaultModel: "haiku" })).toBe("claude-haiku-4-5");
    expect(resolveModel(ws, { agent: "analyst" })).toBe("claude-sonnet-5");
    const custom = { config: parseConfig({ models: { haiku: "claude-haiku-next" } }), secret: () => undefined };
    expect(resolveModel(custom, { agent: "analyst", defaultModel: "haiku" })).toBe("claude-haiku-next");
  });
});

describe("output parsing", () => {
  it("finds JSON in plain, fenced and wrapped answers", () => {
    expect(parseJsonFromText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonFromText('Here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonFromText('Result: [1,2] done')).toEqual([1, 2]);
    expect(parseJsonFromText("no json")).toBeUndefined();
  });

  it("validates structured output against the job schema", () => {
    const schema = z.object({ items: z.array(z.object({ title: z.string() })).max(2) });
    const base = { type: "result", subtype: "success", result: "" } as const;
    expect(validateOutput(schema, { ...base, structured_output: { items: [{ title: "x" }] } } as never)).toEqual({ ok: true, value: { items: [{ title: "x" }] } });
    const bad = validateOutput(schema, { ...base, result: '{"items":[{"title":1}]}' } as never);
    expect(bad.ok).toBe(false);
    expect(validateOutput(schema, { ...base, result: "nope" } as never)).toEqual({ ok: false, error: "The answer wasn't valid JSON." });
  });
});
