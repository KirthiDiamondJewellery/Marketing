import { describe, expect, it } from "vitest";
import { parseConfig, silentLogger } from "@attentionos/core";
import { buildProviderRegistry, implementsKind } from "../src/index.ts";
import { makeWorkspace } from "./helpers.ts";

const fakeProvider = `
export function create(opts) {
  return {
    id: "console",
    token: opts.secret("CONSOLE_TOKEN"),
    async health() { return { ok: true, detail: "ready" }; },
    async send(msg) { return { messageId: "m1" }; },
    async receive() { return { messages: [], cursor: "" }; },
  };
}
`;

describe("provider registry", () => {
  it("loads installed packages from the workspace and explains missing ones", async () => {
    const root = makeWorkspace({
      "package.json": `{"name":"ws","private":true}`,
      "node_modules/@attentionos/provider-notify-testfake/package.json": `{"name":"@attentionos/provider-notify-testfake","type":"module","exports":{".":"./index.js"}}`,
      "node_modules/@attentionos/provider-notify-testfake/index.js": fakeProvider,
    });
    const config = parseConfig({ providers: { notifier: "console", publisher: "zernio", crm: "lite", storage: "local" } });
    const { providers, diagnostics } = await buildProviderRegistry(config, {
      config,
      log: silentLogger,
      secret: (n) => (n === "CONSOLE_TOKEN" ? "t" : undefined),
      search: { workspaceRoot: root, engineRoot: null },
      trendKinds: [],
      mediaDir: `${root}/media`,
      packages: { notifier: { console: "notify-testfake" }, publisher: { zernio: "publish-testmissing" } },
    });
    expect(providers.notifier?.id).toBe("console");
    expect((providers.notifier as unknown as { token: string }).token).toBe("t");
    expect(providers.storage?.id).toBe("local");
    expect(providers.publisher).toBeUndefined();
    const byKind = Object.fromEntries(diagnostics.map((d) => [d.kind, d.status]));
    expect(byKind).toMatchObject({ notifier: "loaded", publisher: "not_installed", crm: "none", storage: "builtin", imageGen: "none" });
  });

  it("checks that an object implements a kind", () => {
    expect(implementsKind({ send() {}, receive() {}, health() {} }, "notifier")).toBe(true);
    expect(implementsKind({ send() {} }, "notifier")).toBe(false);
  });
});
