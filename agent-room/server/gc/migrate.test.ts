import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATED_FILES, migrateState } from "./migrate";

/**
 * The reference tool's state dir shape (slp-gc.bash:169, 1213-1229):
 * `memory.jsonl` and its one rotated predecessor, the lineage ledger, the alert
 * log, the alert stamp, the report stamp, and the rendered reports.
 */
async function seedSource(root: string): Promise<void> {
  await mkdir(join(root, "reports"), { recursive: true, mode: 0o700 });
  for (const name of MIGRATED_FILES) {
    await writeFile(join(root, name), `contents of ${name}\n`, { encoding: "utf8", mode: 0o600 });
  }
  await writeFile(join(root, "reports", "20260101T000000Z.txt"), "an old report\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(root, "reports", "20260102T000000Z.txt"), "a newer report\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agent-room-gc-migrate-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("migrateState", () => {
  it("copies every reference entry, reports/ included, and leaves the source alone", async () => {
    const from = join(workspace, "legacy");
    const to = join(workspace, "gc");
    await seedSource(from);

    const before = await stat(join(from, "memory.jsonl"));
    const result = await migrateState({ from, to });

    expect(result.present).toBe(true);
    expect(result.copied.sort()).toEqual([...MIGRATED_FILES, "reports/"].sort());
    expect(result.skipped).toEqual([]);

    // The contents landed…
    expect(await readFile(join(to, "memory.jsonl"), "utf8")).toBe("contents of memory.jsonl\n");
    expect(await readFile(join(to, "lineage.tsv"), "utf8")).toBe("contents of lineage.tsv\n");
    expect((await readdir(join(to, "reports"))).sort()).toEqual([
      "20260101T000000Z.txt",
      "20260102T000000Z.txt",
    ]);

    // …the modes were carried (`0700` dir, `0600` file: the ledger's own gate)…
    expect((await stat(join(to, "lineage.tsv"))).mode & 0o777).toBe(0o600);
    expect((await stat(to)).mode & 0o777).toBe(0o700);

    // …and the source was read, never written: same bytes, same mtime, same names.
    const after = await stat(join(from, "memory.jsonl"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(join(from, "memory.jsonl"), "utf8")).toBe("contents of memory.jsonl\n");
    expect((await readdir(from)).sort()).toEqual([...MIGRATED_FILES, "reports"].sort());
  });

  it("is idempotent: an existing destination is skipped, never overwritten", async () => {
    const from = join(workspace, "legacy");
    const to = join(workspace, "gc");
    await seedSource(from);
    await migrateState({ from, to });

    // The plugin's own history moves on; a second migration must not roll it back.
    await writeFile(join(to, "memory.jsonl"), "the plugin's newer line\n", "utf8");

    const second = await migrateState({ from, to });
    expect(second.present).toBe(true);
    expect(second.copied).toEqual([]);
    expect(second.skipped.sort()).toEqual([...MIGRATED_FILES, "reports/"].sort());
    expect(await readFile(join(to, "memory.jsonl"), "utf8")).toBe("the plugin's newer line\n");
  });

  it("does nothing at all when the source is absent", async () => {
    const from = join(workspace, "never-existed");
    const to = join(workspace, "gc");

    const result = await migrateState({ from, to });

    expect(result).toEqual({ copied: [], skipped: [], present: false });
    // Not even the destination was created: an absent source is not a fault.
    await expect(stat(to)).rejects.toThrow();
  });

  it("copies the entries it can when one of them cannot be copied", async () => {
    const from = join(workspace, "legacy");
    const to = join(workspace, "gc");
    await seedSource(from);

    const result = await migrateState({
      from,
      to,
      copyFile: async (source, target) => {
        if (source.endsWith("lineage.tsv")) throw new Error("EACCES");
        await writeFile(target, await readFile(source, "utf8"), "utf8");
      },
    });

    expect(result.copied).toContain("memory.jsonl");
    expect(result.copied).not.toContain("lineage.tsv");
  });

  it("skips a symlinked source entry rather than following it", async () => {
    const from = join(workspace, "legacy");
    const to = join(workspace, "gc");
    await mkdir(from, { recursive: true });
    await writeFile(join(from, "memory.jsonl"), "real\n", "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc/hosts", join(from, "lineage.tsv"));

    const result = await migrateState({ from, to });

    expect(result.copied).toEqual(["memory.jsonl"]);
    await expect(readFile(join(to, "lineage.tsv"), "utf8")).rejects.toThrow();
  });
});
