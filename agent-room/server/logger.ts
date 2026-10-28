export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const PREFIX = "[agent-room]";

// Callers pass ids, counts, tiers and statuses only. Never message text: plugin
// output is retained in daemon.log.
export const consoleLogger: Logger = {
  info: (message, fields) => console.info(PREFIX, message, fields ?? ""),
  warn: (message, fields) => console.warn(PREFIX, message, fields ?? ""),
  error: (message, fields) => console.error(PREFIX, message, fields ?? ""),
};
