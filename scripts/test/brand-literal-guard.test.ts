import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM script without type declarations
import { isExcluded, loadDenyList, parseDenyList, scanPaths, scanText } from "../brand-literal-guard.mjs";

type Finding = { kind: string; match: string; line: number; column: number; file?: string };

// Sample violations are assembled at runtime so this file never contains them literally.
const at = "@";
const homePath = ["", "Users", "pat", "projects", "brand"].join("/");
const realEmail = `pat.owner${at}mail.invalid`;
const phone = ["(415)", "555-0134"].join(" ");
const phoneDashed = ["415", "555", "0134"].join("-");
const phoneIntl = ["+44", "20", "7946", "0958"].join(" ");
const chatId = "-100" + "1234567890";

const kinds = (text: string, deny: unknown[] = []) => (scanText(text, { deny }) as Finding[]).map((f) => f.kind);

describe("scanText", () => {
  it("flags personal home-directory paths but not placeholders", () => {
    expect(kinds(`cd ${homePath}`)).toEqual(["home-path"]);
    expect(kinds("C:\\" + "Users\\" + "pat\\brand")).toEqual(["home-path"]);
    expect(kinds("cd /Users/you/my-brand")).toEqual([]);
    expect(kinds("cd /Users/<name>/my-brand")).toEqual([]);
    expect(kinds("cd /home/runner/work")).toEqual([]);
  });

  it("flags emails outside example domains", () => {
    expect(kinds(`write to ${realEmail}`)).toEqual(["email"]);
    expect(kinds(`hello${at}example.com, team${at}example.org, jordan${at}examplebrand.example`)).toEqual([]);
    expect(kinds(`git clone git${at}github.com:evanbaker315/AttentionOS.git`)).toEqual([]);
  });

  it("ignores package specifiers and connection strings", () => {
    expect(kinds(`pnpm${at}12.11.2 zod${at}4.6.5 actions/checkout${at}v4 attentionos${at}attentionos`)).toEqual([]);
    expect(kinds(`postgresql://postgres:secret${at}db.internal.supabase.co:5432/postgres`)).toEqual([]);
  });

  it("flags phone numbers in common formats", () => {
    expect(kinds(`call ${phone}`)).toEqual(["phone"]);
    expect(kinds(`call ${phoneDashed}`)).toEqual(["phone"]);
    expect(kinds(`call ${phoneIntl}`)).toEqual(["phone"]);
  });

  it("does not mistake dates, versions, UUIDs or ids for phone numbers", () => {
    const text = [
      "released 2026-10-24 at 09:30",
      "version 1.12.3 and 0.1.0",
      "id 00000000-0000-4000-8000-000000000001",
      "ip 127.0.0.1 port 56522",
      "cron 30 7 * * 1-5",
      "costs $1,799 and 1,000,000 views",
    ].join("\n");
    expect(kinds(text)).toEqual([]);
  });

  it("flags Telegram chat ids", () => {
    expect(kinds(`TELEGRAM_CHAT_ID=${chatId}`)).toEqual(["chat-id"]);
  });

  it("honours the allow marker", () => {
    expect(kinds(`${realEmail} // brand-literal-guard: allow`)).toEqual([]);
  });

  it("reports 1-based line and column", () => {
    const [f] = scanText(`ok\n  ${realEmail}`, { deny: [] }) as Finding[];
    expect(f).toMatchObject({ line: 2, column: 3, kind: "email" });
  });
});

describe("deny-list", () => {
  it("matches plain entries case-insensitively on word boundaries", () => {
    const deny = parseDenyList("# comment\nAcme Widgets\n");
    expect(kinds("We love ACME widgets.", deny)).toEqual(["deny-list"]);
    expect(kinds("acmewidgetsco is different", deny)).toEqual([]);
  });

  it("supports regular expressions", () => {
    const deny = parseDenyList("re:\\bwidget-\\d+\\b");
    expect(kinds("see widget-42 here", deny)).toEqual(["deny-list"]);
  });

  it("masks deny-list matches so CI logs don't repeat private names", () => {
    const deny = parseDenyList("Secret Client");
    const [f] = scanText("about Secret Client", { deny }) as Finding[];
    expect(f?.match).not.toContain("Secret Client");
  });

  it("rejects invalid patterns with a clear message", () => {
    expect(() => parseDenyList("re:(", "private.deny")).toThrow(/private.deny:1/);
  });
});

describe("scanPaths", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const put = (rel: string, text: string) => {
    const full = join(root!, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  it("scans code, skills and docs and skips fixtures and node_modules", () => {
    root = mkdtempSync(join(tmpdir(), "guard-"));
    put("docs/setup.md", `Email ${realEmail}\n`);
    put("modules/x/skills/s/SKILL.md", `Path ${homePath}\n`);
    put("modules/x/src/a.ts", "export const ok = 1;\n");
    put("packages/providers/p/test/fixtures/reply.json", `{"email":"${realEmail}"}`);
    put("node_modules/pkg/readme.md", realEmail);
    put("media/clip.mp4", "\u0000binary");
    const { findings } = scanPaths({ root, deny: [] }) as { findings: Finding[] };
    expect(findings.map((f) => `${f.file}:${f.kind}`).sort()).toEqual(["docs/setup.md:email", "modules/x/skills/s/SKILL.md:home-path"]);
  });

  it("loads the private deny-list from ATTENTIONOS_DENYLIST", () => {
    root = mkdtempSync(join(tmpdir(), "guard-"));
    put("scripts/brand-literals.deny", "placeholder-name\n");
    put("private.deny", "Hidden Brand\n");
    const deny = loadDenyList({ root, env: { ATTENTIONOS_DENYLIST: join(root, "private.deny") } });
    expect(deny).toHaveLength(2);
    put("README.md", "Built for Hidden Brand.\n");
    const { findings } = scanPaths({ root, deny }) as { findings: Finding[] };
    expect(findings.map((f) => f.kind)).toEqual(["deny-list"]);
  });

  it("fails loudly when ATTENTIONOS_DENYLIST points nowhere", () => {
    root = mkdtempSync(join(tmpdir(), "guard-"));
    expect(() => loadDenyList({ root, env: { ATTENTIONOS_DENYLIST: join(root, "missing.deny") } })).toThrow(/missing file/);
  });

  it("excludes the right paths", () => {
    expect(isExcluded("modules/ops/test/fixtures/telegram/update.json")).toBe(true);
    expect(isExcluded("plugin/skills/x/SKILL.md")).toBe(true);
    expect(isExcluded("modules/ops/src/index.ts")).toBe(false);
    expect(isExcluded("docs/fixtures-explained.md")).toBe(false);
  });

  it("the shipped scripts, plugin sources, templates and presets are clean", () => {
    const paths = ["scripts", "plugin-src", ".claude-plugin", "templates", "presets", "modules/ops"];
    const { findings } = scanPaths({ paths, deny: [] }) as { findings: Finding[] };
    expect(findings).toEqual([]);
  });
});
