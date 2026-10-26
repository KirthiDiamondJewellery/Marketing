import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";

describe("attentionos main", () => {
  let out: string;
  let err: string;
  beforeEach(() => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
  });
  afterEach(() => vi.restoreAllMocks());

  it("prints help and the version", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("attentionos <command>");
    out = "";
    expect(await main(["--version"])).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("explains unknown commands and bad options without a stack trace", async () => {
    expect(await main(["publish-everything"])).toBe(1);
    expect(err).toContain(`"publish-everything" isn't an AttentionOS command.`);
    expect(err).not.toContain("    at ");
    err = "";
    expect(await main(["status", "--colour"])).toBe(1);
    expect(err).toMatch(/Unknown option '--colour' for `status`/);
  });

  it("says when there is no workspace", async () => {
    const empty = mkdtempSync(join(tmpdir(), "aos-main-"));
    expect(await main(["status", "-w", empty])).toBe(1);
    expect(err).toContain("No AttentionOS workspace found here.");
  });

  it("prints update instructions without touching git", async () => {
    expect(await main(["update"])).toBe(0);
    expect(out).toContain("./aos update");
    expect(out).not.toMatch(/\bgit\b/);
  });
});
