import { describe, expect, it } from "vitest";
import { parseCreateArgs, splitCommand } from "../src/args.ts";
import { UserError } from "../src/errors.ts";
import { parseInputFlag } from "../src/commands/run.ts";
import { nodeVersionOk } from "../src/commands/doctor.ts";

describe("attentionos create arguments", () => {
  it("parses a folder with defaults", () => {
    expect(parseCreateArgs(["my-brand"])).toMatchObject({ dir: "my-brand", preset: "coach-consultant", yes: false, help: false });
  });

  it("parses every option in any order", () => {
    const a = parseCreateArgs(["--preset", "agency-founder", "my brand", "--name", "Examplebrand Studio", "--timezone", "America/Chicago", "-y"]);
    expect(a).toEqual({ dir: "my brand", preset: "agency-founder", name: "Examplebrand Studio", timezone: "America/Chicago", yes: true, help: false });
    expect(parseCreateArgs(["x", "-p", "agency-founder"]).preset).toBe("agency-founder");
    expect(parseCreateArgs(["x", "--preset=agency-founder"]).preset).toBe("agency-founder");
  });

  it("explains mistakes in plain language", () => {
    expect(() => parseCreateArgs([])).toThrow(/Tell me where to create the workspace/);
    expect(() => parseCreateArgs(["a", "b"])).toThrow(/Expected one folder name/);
    expect(() => parseCreateArgs(["a", "--preset", "dentist"])).toThrow(/no "dentist" preset/);
    expect(() => parseCreateArgs(["a", "--timezone", "Mars/Olympus"])).toThrow(/isn't a timezone/);
    expect(() => parseCreateArgs(["a", "--colour", "blue"])).toThrow(UserError);
    expect(() => parseCreateArgs(["a", "--name", "  "])).toThrow(/1 to 80 characters/);
  });

  it("accepts presets discovered at runtime and --help without a folder", () => {
    expect(parseCreateArgs(["a", "--preset", "local-service"], ["local-service"]).preset).toBe("local-service");
    expect(parseCreateArgs(["--help"]).help).toBe(true);
  });
});

describe("command line splitting", () => {
  it("finds the command word around global flags", () => {
    expect(splitCommand(["--debug", "status", "--json"])).toMatchObject({ command: "status", args: ["--debug", "--json"], debug: true });
    expect(splitCommand(["-w", "status", "run", "x"])).toMatchObject({ command: "run", workspace: "status", args: ["-w", "status", "x"] });
    expect(splitCommand(["--workspace=/tmp/ws", "doctor"])).toMatchObject({ command: "doctor", workspace: "/tmp/ws" });
    expect(splitCommand(["--version"])).toMatchObject({ command: null, version: true });
  });
});

describe("small helpers", () => {
  it("parses --input JSON", () => {
    expect(parseInputFlag(undefined)).toEqual({});
    expect(parseInputFlag('{"limit":2}')).toEqual({ limit: 2 });
    expect(() => parseInputFlag("{limit:2}")).toThrow(/isn't valid JSON/);
    expect(() => parseInputFlag("@/nope/missing.json")).toThrow(/not found/);
  });

  it("checks the Node version", () => {
    expect(nodeVersionOk("22.18.0")).toBe(true);
    expect(nodeVersionOk("22.17.1")).toBe(false);
    expect(nodeVersionOk("24.1.0")).toBe(true);
    expect(nodeVersionOk("22.12.9")).toBe(false);
    expect(nodeVersionOk("20.18.0")).toBe(false);
  });
});
