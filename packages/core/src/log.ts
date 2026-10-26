export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON-lines logger on stderr (stdout is reserved for MCP stdio and CLI output). */
export function createLogger(opts: { level?: LogLevel; bindings?: Record<string, unknown>; write?: (line: string) => void } = {}): Logger {
  const level = opts.level ?? ((process.env.ATTENTIONOS_LOG_LEVEL as LogLevel | undefined) ?? "info");
  const write = opts.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const bindings = opts.bindings ?? {};
  const emit = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    write(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...bindings, ...data }));
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    child: (b) => createLogger({ level, bindings: { ...bindings, ...b }, write }),
  };
}

export const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};
