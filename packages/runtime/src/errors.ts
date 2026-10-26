import type { z } from "zod";

/** A problem the user can fix. `message` and `fix` are plain language and shown as-is by the CLI and doctor. */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly fix?: string,
    public readonly code: "no_workspace" | "config" | "env" | "database" | "module" | "provider" = "config",
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((i) => {
      const where = i.path.length ? i.path.map(String).join(".") : "(top level)";
      return `${where}: ${i.message}`;
    })
    .join("; ");
}
