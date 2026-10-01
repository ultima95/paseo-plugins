export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const PREFIX = "[schedule-sending]";

// Callers pass ids, counts and statuses only. Never message text: plugin output is retained in daemon.log.
export const consoleLogger: Logger = {
  info: (message, fields) => console.log(PREFIX, message, fields ?? ""),
  error: (message, fields) => console.error(PREFIX, message, fields ?? ""),
};
