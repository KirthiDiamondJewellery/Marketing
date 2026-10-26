import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("Studio action authentication coverage", () => {
  it("requires a session in every exported server action", () => {
    const dir = resolve(import.meta.dirname, "../src/server/actions");
    const missing: string[] = [];
    for (const name of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const file = ts.createSourceFile(name, readFileSync(resolve(dir, name), "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of file.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        let checked = false;
        const visit = (node: ts.Node) => {
          if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(file) === "requireSession") checked = true;
          ts.forEachChild(node, visit);
        };
        visit(statement.body);
        if (!checked) missing.push(`${name}:${statement.name?.text}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
