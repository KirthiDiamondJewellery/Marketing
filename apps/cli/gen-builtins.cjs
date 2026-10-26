// Regenerates src/builtins.ts and the matching devDependencies from modules/ and packages/providers/.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const list = (dir) => fs.readdirSync(path.join(root, dir)).filter((d) => fs.existsSync(path.join(root, dir, d, "package.json"))).sort();
const mods = list("modules");
const provs = list("packages/providers");
const names = [...mods.map((m) => `@attentionos/module-${m}`), ...provs.map((d) => `@attentionos/provider-${d}`)];
const out = [
  'import { registerBuiltins } from "@attentionos/runtime";',
  "",
  "/**",
  " * Every module and provider adapter shipped in the attentionos package. Static imports let the bundler include",
  " * them (each in its own chunk, loaded on first use). Regenerate with `node apps/cli/gen-builtins.cjs`.",
  " */",
  "registerBuiltins({",
  ...names.map((n) => `  "${n}": () => import("${n}"),`),
  "});",
  "",
];
fs.writeFileSync(path.join(__dirname, "src", "builtins.ts"), out.join("\n"));
const pkgPath = path.join(__dirname, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
for (const n of names) pkg.devDependencies[n] = "workspace:*";
pkg.devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies).sort());
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
