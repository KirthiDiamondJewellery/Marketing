import pc from "picocolors";

/** Plain-language terminal output. Everything goes to stdout except errors (stderr). */
export const ui = {
  out: (line = "") => process.stdout.write(`${line}\n`),
  title: (text: string) => process.stdout.write(`\n${pc.bold(text)}\n\n`),
  ok: (text: string, detail?: string) => process.stdout.write(`  ${pc.green("✓")} ${text}${detail ? pc.dim(`  ${detail}`) : ""}\n`),
  warn: (text: string, detail?: string) => process.stdout.write(`  ${pc.yellow("!")} ${text}${detail ? pc.dim(`  ${detail}`) : ""}\n`),
  fail: (text: string, detail?: string) => process.stdout.write(`  ${pc.red("✗")} ${text}${detail ? pc.dim(`  ${detail}`) : ""}\n`),
  skip: (text: string, detail?: string) => process.stdout.write(`  ${pc.dim("-")} ${pc.dim(text)}${detail ? pc.dim(`  ${detail}`) : ""}\n`),
  fix: (text: string) => process.stdout.write(`      ${pc.cyan("→")} ${text}\n`),
  step: (n: number, text: string) => process.stdout.write(`  ${pc.cyan(`${n}.`)} ${text}\n`),
  dim: (text: string) => pc.dim(text),
  bold: (text: string) => pc.bold(text),
  code: (text: string) => pc.cyan(text),
  error: (text: string, fix?: string) => {
    process.stderr.write(`${pc.red("Error:")} ${text}\n`);
    if (fix) process.stderr.write(`${pc.cyan("→")} ${fix}\n`);
  },
};
