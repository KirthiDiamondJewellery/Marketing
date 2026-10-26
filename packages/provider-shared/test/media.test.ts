import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ffprobe } from "../src/index.ts";

describe("ffprobe", () => {
  const before = process.env.ATTENTIONOS_FFPROBE;
  afterEach(() => {
    if (before === undefined) delete process.env.ATTENTIONOS_FFPROBE;
    else process.env.ATTENTIONOS_FFPROBE = before;
  });

  it("uses the binary named by ATTENTIONOS_FFPROBE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-ffprobe-"));
    const bin = join(dir, "my-ffprobe");
    writeFileSync(bin, `#!/usr/bin/env node\nconst s = process.argv[process.argv.indexOf("-select_streams") + 1];\nprocess.stdout.write(s === "v:0" ? "h264\\n" : "aac\\n");\n`);
    chmodSync(bin, 0o755);
    process.env.ATTENTIONOS_FFPROBE = bin;
    expect(await ffprobe(join(dir, "clip.mp4"))).toEqual({ videoCodec: "h264", audioCodec: "aac" });
  });

  it("reports unchecked when the configured binary doesn't exist", async () => {
    process.env.ATTENTIONOS_FFPROBE = "/nonexistent/ffprobe";
    expect(await ffprobe("/tmp/clip.mp4")).toBeUndefined();
  });
});
