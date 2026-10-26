import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceContent } from "../src/workspace-files.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aos-content-")); roots.push(root);
  await mkdir(join(root, "brand"));
  await writeFile(join(root, "brand/voice.md"), "Plain language");
  await writeFile(join(root, ".env"), "SECRET=not-for-agents");
  return root;
}
describe("agent content boundary", () => {
  it("reads and lists approved content", async () => {
    const root = await fixture();
    expect(await readWorkspaceContent(root, "brand/voice.md")).toEqual({ text: "Plain language" });
    expect(await readWorkspaceContent(root, "brand")).toEqual({ entries: ["brand/voice.md"] });
  });
  it("rejects credentials, traversal, executable config and symlink aliases", async () => {
    const root = await fixture();
    await symlink(join(root, ".env"), join(root, "brand/alias.md"));
    await symlink(root, join(root, "brand/linked"));
    for (const path of [".env", "brand/../.env", "../outside.md", "/etc/passwd", "config/attentionos.config.ts", "brand/.env", "brand/credentials.json", "brand/alias.md", "brand/linked/brand/voice.md"]) await expect(readWorkspaceContent(root, path), path).rejects.toThrow();
    expect((await readWorkspaceContent(root, "brand")).entries).toEqual(["brand/voice.md"]);
  });
  it("bounds file reads", async () => {
    const root = await fixture(); await writeFile(join(root, "brand/large.md"), "x".repeat(256 * 1024 + 1));
    await expect(readWorkspaceContent(root, "brand/large.md")).rejects.toThrow("256 KB");
  });
});
