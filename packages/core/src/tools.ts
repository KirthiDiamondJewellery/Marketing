import type { z } from "zod";
import type { Actor } from "./types.ts";
import type { WorkspaceContext } from "./workspace.ts";

/**
 * An MCP tool contributed by a module ("One data layer"). The MCP server registers every enabled
 * module's tools, attributes each call to an actor, and returns compact JSON.
 * Rules belong INSIDE tools (keyword collisions, idempotency, approval checks), not in prompts.
 */
export type ToolContext = { ws: WorkspaceContext; actor: Actor };

export type ToolDefinition<I extends z.ZodObject = z.ZodObject> = {
  /** snake_case, prefixed with the module id: `research_list_outliers`. */
  name: string;
  /** What it does and when to use it, written for the model. */
  description: string;
  input: I;
  annotations?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean };
  handler(ctx: ToolContext, input: z.output<I>): Promise<unknown>;
};

export function defineTool<I extends z.ZodObject>(tool: ToolDefinition<I>): ToolDefinition<I> {
  return tool;
}

/** Thrown by tool handlers for user-correctable problems; the MCP server returns it as an isError result. */
export class ToolError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "ToolError";
  }
}
