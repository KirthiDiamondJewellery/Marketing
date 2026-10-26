/** Native filesystem and execution tools bypass the engine's content boundary. Both engines use this policy. */
export const DENIED_NATIVE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent"];
export const CONTENT_TOOL = "mcp__attentionos__core_read_content";

export function effectiveTools(requested: string[]): string[] {
  const content = requested.some((t) => ["Read", "Glob", "Grep"].includes(t.replace(/\(.*$/, "")));
  return [...new Set([...requested.filter((t) => !DENIED_NATIVE_TOOLS.includes(t.replace(/\(.*$/, ""))), ...(content ? [CONTENT_TOOL] : [])])];
}
