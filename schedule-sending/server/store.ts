import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HISTORY_RETENTION_MS, queueFileSchema, type ScheduledMessage } from "../shared/model";
import type { Logger } from "./logger";

export interface QueueStore {
  load(): Promise<void>;
  list(): ScheduledMessage[];
  get(id: string): ScheduledMessage | undefined;
  add(item: ScheduledMessage): Promise<void>;
  update(
    id: string,
    change: (item: ScheduledMessage) => ScheduledMessage,
  ): Promise<ScheduledMessage | undefined>;
  prune(now: number): Promise<void>;
}

export function resolveDataDir(env: Record<string, string | undefined>, home: string): string {
  const base = env.PASEO_HOME !== undefined && env.PASEO_HOME !== "" ? env.PASEO_HOME : path.join(home, ".paseo");
  return path.join(base, "plugin-data", "schedule-sending");
}

function parseQueue(raw: string): ScheduledMessage[] | undefined {
  try {
    const result = queueFileSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data.items : undefined;
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function createFileStore(options: { dir: string; now: () => number; log: Logger }): QueueStore {
  const { dir, now, log } = options;
  const file = path.join(dir, "queue.json");
  let items: ScheduledMessage[] = [];
  let writeChain: Promise<void> = Promise.resolve();

  // The snapshot is taken when the write is queued; writes run one at a time, so the last one wins.
  function persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, items });
    const write = writeChain.then(async () => {
      await mkdir(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, file);
    });
    writeChain = write.catch(() => undefined);
    return write;
  }

  async function quarantine(): Promise<void> {
    const target = path.join(dir, `queue.corrupt-${now()}.json`);
    await rename(file, target);
    log.error("queue file unreadable; moved aside and starting empty", { target });
  }

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (isNotFound(error)) {
          items = [];
          return;
        }
        throw error;
      }
      const parsed = parseQueue(raw);
      if (parsed === undefined) {
        await quarantine();
        items = [];
        return;
      }
      items = parsed;
    },

    list: () => items.map((item) => ({ ...item })),

    get(id) {
      const found = items.find((item) => item.id === id);
      return found === undefined ? undefined : { ...found };
    },

    async add(item) {
      items.push({ ...item });
      try {
        await persist();
      } catch (error) {
        items = items.filter((existing) => existing.id !== item.id);
        throw error;
      }
    },

    async update(id, change) {
      const index = items.findIndex((item) => item.id === id);
      const current = items[index];
      if (current === undefined) return undefined;
      const next = change({ ...current });
      items[index] = next;
      await persist();
      return { ...next };
    },

    async prune(cutoffNow) {
      const before = items.length;
      items = items.filter(
        (item) => item.status === "pending" || cutoffNow - (item.finishedAt ?? item.createdAt) <= HISTORY_RETENTION_MS,
      );
      if (items.length !== before) await persist();
    },
  };
}
