import { parseArgs, type ParseArgsConfig } from "node:util";
import { UserError } from "./errors.ts";

export const COMMON_OPTIONS = {
  debug: { type: "boolean", default: false },
  workspace: { type: "string", short: "w" },
  help: { type: "boolean", short: "h", default: false },
} as const satisfies ParseArgsConfig["options"];

export type Parsed<O extends NonNullable<ParseArgsConfig["options"]>> = {
  values: { [K in keyof (O & typeof COMMON_OPTIONS)]?: (O & typeof COMMON_OPTIONS)[K] extends { type: "boolean" } ? boolean : string };
  positionals: string[];
};

/** Strict per-command parsing; unknown flags become a plain-language error. */
export function parseCommand<O extends NonNullable<ParseArgsConfig["options"]>>(command: string, args: string[], options: O): Parsed<O> {
  try {
    const res = parseArgs({ args, options: { ...COMMON_OPTIONS, ...options }, allowPositionals: true, strict: true });
    return res as unknown as Parsed<O>;
  } catch (err) {
    const msg = (err as Error).message.replace(/^.*?Unknown option/, "Unknown option").split(". ")[0];
    throw new UserError(`${msg} for \`${command}\`.`, `Run \`attentionos ${command} --help\` to see what it accepts.`);
  }
}

/**
 * Splits `attentionos [globals] <command> [args]`. Global flags may appear anywhere; `-w/--workspace <folder>`
 * is the only one that takes a value, so its value is never mistaken for the command word.
 */
export function splitCommand(argv: string[]): { command: string | null; args: string[]; debug: boolean; version: boolean; workspace?: string } {
  let index = -1;
  let workspace: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-w" || a === "--workspace") {
      workspace ??= argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith("--workspace=")) workspace ??= a.slice("--workspace=".length);
    if (!a.startsWith("-") && index === -1) index = i;
  }
  const command = index === -1 ? null : argv[index]!;
  return {
    command,
    args: index === -1 ? argv : [...argv.slice(0, index), ...argv.slice(index + 1)],
    debug: argv.includes("--debug") || process.env.ATTENTIONOS_DEBUG === "1",
    version: index === -1 && (argv.includes("--version") || argv.includes("-v")),
    workspace,
  };
}

export const DEFAULT_PRESETS = ["coach-consultant", "agency-founder"] as const;

export type CreateArgs = {
  dir: string;
  preset: string;
  name?: string;
  timezone?: string;
  yes: boolean;
  help: boolean;
};

/** `attentionos create <dir> [--preset coach-consultant|agency-founder] [--name "..."] [--timezone Area/City]` */
export function parseCreateArgs(argv: string[], presets: readonly string[] = DEFAULT_PRESETS): CreateArgs {
  const { values, positionals } = parseCommand("create", argv, {
    preset: { type: "string", short: "p" },
    name: { type: "string" },
    timezone: { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
  });
  const help = Boolean(values.help);
  if (help) return { dir: "", preset: presets[0] ?? "coach-consultant", yes: false, help };
  if (positionals.length === 0) {
    throw new UserError("Tell me where to create the workspace.", "Example: attentionos create my-brand --preset coach-consultant");
  }
  if (positionals.length > 1) {
    throw new UserError(`Expected one folder name, got ${positionals.length}: ${positionals.join(" ")}.`, 'Put names with spaces in quotes, e.g. "my brand".');
  }
  const preset = (values.preset as string | undefined) ?? presets[0] ?? "coach-consultant";
  if (!presets.includes(preset)) {
    throw new UserError(`There is no "${preset}" preset.`, `Choose one of: ${presets.join(", ")}.`);
  }
  const timezone = values.timezone as string | undefined;
  if (timezone && !isTimezone(timezone)) {
    throw new UserError(`"${timezone}" isn't a timezone I know.`, "Use an IANA name like America/Chicago or Europe/London.");
  }
  const name = (values.name as string | undefined)?.trim();
  if (name !== undefined && (name.length === 0 || name.length > 80 || /[\r\n]/.test(name))) {
    throw new UserError("The brand name must be 1 to 80 characters on one line.");
  }
  return { dir: positionals[0]!, preset, name, timezone, yes: Boolean(values.yes), help };
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
