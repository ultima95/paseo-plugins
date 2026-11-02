import { describe, expect, it, vi } from "vitest";

import { repoScope, workspaceScope } from "../shared/member";
import {
  candidateScope,
  createRepoResolver,
  normalizeRemoteUrl,
  repoIdFromText,
} from "./scope";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("repo identity", () => {
  it("normalizes ssh and https remotes to the same identity", () => {
    expect(normalizeRemoteUrl("git@github.com:Acme/App.git")).toBe("github.com/Acme/App");
    expect(normalizeRemoteUrl("https://github.com/Acme/App.git")).toBe("github.com/Acme/App");
    expect(normalizeRemoteUrl("ssh://git@github.com/Acme/App.git")).toBe("github.com/Acme/App");
  });

  it("hashes stably across clones of one repo", () => {
    expect(repoIdFromText("github.com/Acme/App")).toBe(repoIdFromText("github.com/Acme/App"));
    expect(repoIdFromText("github.com/Acme/App")).not.toBe(repoIdFromText("github.com/Acme/Other"));
    expect(repoIdFromText("github.com/Acme/App")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("createRepoResolver", () => {
  it("prefers the origin remote and memoizes per cwd", async () => {
    const run = vi.fn(async (args: readonly string[], cwd: string) => {
      if (args[0] === "remote") {
        return {
          code: 0,
          stdout: cwd.startsWith("/clone") ? "git@github.com:Acme/App.git\n" : "https://github.com/Acme/App.git\n",
        };
      }
      return { code: 1, stdout: "" };
    });
    const resolve = createRepoResolver({ run, log });

    const a = await resolve("/clone/one/");
    const b = await resolve("/other/two");
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(2);
    await resolve("/clone/one/");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("falls back to the repository root when there is no remote", async () => {
    const run = async (args: readonly string[]) =>
      args[0] === "rev-parse"
        ? { code: 0, stdout: "/work/app\n" }
        : { code: 1, stdout: "" };
    const resolve = createRepoResolver({ run, log });
    expect(await resolve("/work/app/sub")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns null outside a git repository instead of throwing", async () => {
    const run = vi.fn(async () => ({ code: 128, stdout: "" }));
    const resolve = createRepoResolver({ run, log });
    await expect(resolve("/not/a/repo")).resolves.toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("candidateScope", () => {
  it("uses the repo when one resolved, else the workspace", () => {
    expect(candidateScope("/a/b", "8f3c1a2b")).toBe(repoScope("8f3c1a2b"));
    expect(candidateScope("/a/b/", null)).toBe(workspaceScope("/a/b"));
  });
});
