import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_RETENTION_MS, type ScheduledMessage } from "../shared/model";
import type { Logger } from "./logger";
import { createFileStore, resolveDataDir } from "./store";

const errors: string[] = [];
const recording: Logger = {
  info() {},
  error: (message) => {
    errors.push(message);
  },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "schedule-store-"));
  errors.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const item = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: "a",
  agentId: "agent-1",
  text: "hi",
  fireAt: 1_000,
  createdAt: 0,
  status: "pending",
  attempts: 0,
  ...over,
});

const make = (now: () => number = () => 10_000) => createFileStore({ dir, now, log: recording });

describe("resolveDataDir", () => {
  it("uses PASEO_HOME when set", () => {
    expect(resolveDataDir({ PASEO_HOME: "/data/paseo" }, "/home/u")).toBe(
      path.join("/data/paseo", "plugin-data", "schedule-sending"),
    );
  });

  it("falls back to ~/.paseo when PASEO_HOME is unset or empty", () => {
    const expected = path.join("/home/u", ".paseo", "plugin-data", "schedule-sending");
    expect(resolveDataDir({}, "/home/u")).toBe(expected);
    expect(resolveDataDir({ PASEO_HOME: "" }, "/home/u")).toBe(expected);
  });
});

describe("file store", () => {
  it("starts empty when the file is missing", async () => {
    const store = make();
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it("persists added items across a fresh instance", async () => {
    const first = make();
    await first.load();
    await first.add(item({ id: "a" }));
    await first.add(item({ id: "b", text: "second" }));

    const second = make();
    await second.load();
    expect(second.list().map((i) => i.id)).toEqual(["a", "b"]);
    expect(second.get("b")?.text).toBe("second");
  });

  it("updates and persists a patch, and returns undefined for an unknown id", async () => {
    const store = make();
    await store.load();
    await store.add(item());
    const updated = await store.update("a", (current) => ({ ...current, attempts: 3 }));
    expect(updated?.attempts).toBe(3);
    expect(await store.update("missing", (current) => current)).toBeUndefined();

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.get("a")?.attempts).toBe(3);
  });

  it("leaves no temp files behind", async () => {
    const store = make();
    await store.load();
    await store.add(item());
    expect(await readdir(dir)).toEqual(["queue.json"]);
  });

  it("keeps every item when many writes are issued concurrently", async () => {
    const store = make();
    await store.load();
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.add(item({ id: `id-${index}` }))));

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(20);
  });

  it("returns copies so callers cannot mutate stored state", async () => {
    const store = make();
    await store.load();
    await store.add(item());
    store.list()[0]!.text = "tampered";
    expect(store.get("a")!.text).toBe("hi");
  });

  it("prunes finished items past retention and keeps the rest", async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const store = make(() => now);
    await store.load();
    await store.add(item({ id: "old-pending", createdAt: 0 }));
    await store.add(item({ id: "old-sent", status: "sent", finishedAt: now - HISTORY_RETENTION_MS - 1 }));
    await store.add(item({ id: "edge-sent", status: "sent", finishedAt: now - HISTORY_RETENTION_MS }));
    await store.add(item({ id: "new-failed", status: "failed", finishedAt: now - 1_000 }));
    await store.prune(now);
    expect(store.list().map((i) => i.id).sort()).toEqual(["edge-sent", "new-failed", "old-pending"]);
  });
});

describe("corrupt files", () => {
  const cases: Array<[string, string]> = [
    ["invalid JSON", "{not json"],
    ["truncated JSON", '{"version":1,"items":[{"id":"a"'],
    ["wrong version", JSON.stringify({ version: 2, items: [] })],
    ["schema-invalid item", JSON.stringify({ version: 1, items: [{ id: "a" }] })],
  ];

  it.each(cases)("quarantines %s and starts empty", async (_name, contents) => {
    await writeFile(path.join(dir, "queue.json"), contents, "utf8");
    const store = make(() => 12_345);
    await store.load();

    expect(store.list()).toEqual([]);
    expect(errors).toHaveLength(1);
    const files = await readdir(dir);
    expect(files).toEqual(["queue.corrupt-12345.json"]);
    expect(await readFile(path.join(dir, "queue.corrupt-12345.json"), "utf8")).toBe(contents);

    await store.add(item());
    const reloaded = make();
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
  });
});
