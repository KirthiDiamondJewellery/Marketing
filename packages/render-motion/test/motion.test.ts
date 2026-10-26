import { parseConfig } from "@attentionos/core";
import { describe, expect, it } from "vitest";
import { createMotionRenderer, MotionEngineUnavailable } from "../src/index.ts";

describe("render-motion stub", () => {
  it("implements the renderer contract and explains why it can't render yet", async () => {
    const r = createMotionRenderer({ config: parseConfig({}) });
    expect(r.id).toBe("motion");
    expect(r.supports({} as never).ok).toBe(false);
    await expect(r.render({} as never)).rejects.toThrow(/license acknowledged/);
    const ack = createMotionRenderer({ config: parseConfig({ acknowledgements: { remotionLicense: true } }) });
    const err = await ack.render({} as never).catch((e) => e);
    expect(err).toBeInstanceOf(MotionEngineUnavailable);
    expect(err.fix).toMatch(/cut/);
  });
});
