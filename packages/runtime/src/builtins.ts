/**
 * Modules and provider adapters shipped inside the `attentionos` package. The CLI registers a static map of
 * `() => import("@attentionos/module-x")` loaders, so the bundler includes every one of them; `importOptional`
 * checks this map before resolving anything by name. From source, unregistered packages still resolve by name.
 */
export type PackageLoader = () => Promise<unknown>;

const builtins = new Map<string, PackageLoader>();

/** Keys are package names: `@attentionos/module-<id>` or `@attentionos/provider-<dir>`. */
export function registerBuiltins(entries: Record<string, PackageLoader>): void {
  for (const [name, loader] of Object.entries(entries)) builtins.set(name, loader);
}

export function builtinLoader(name: string): PackageLoader | undefined {
  return builtins.get(name);
}

/** Module ids with a registered loader. */
export function builtinModuleIds(): string[] {
  return [...builtins.keys()].filter((k) => k.startsWith("@attentionos/module-")).map((k) => k.slice("@attentionos/module-".length));
}
