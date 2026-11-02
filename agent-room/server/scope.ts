import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { normalizeWorkspacePath, repoScope, workspaceScope } from "../shared/member";
import type { Logger } from "./logger";

const execFileAsync = promisify(execFile);

export interface ScopeRun {
  (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

export interface ScopeDeps {
  /** Test seam; production runs `git`. */
  run?: ScopeRun;
  log: Logger;
  timeoutMs?: number;
}

/**
 * Reduce a remote URL to `host/path`, or a local path to itself. Both clone
 * directories of one repository must hash the same, so the transport, the user
 * and the `.git` suffix are not identity.
 */
export function normalizeRemoteUrl(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  const scp = /^[^\s@]+@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp !== null) {
    const path = scp[2]!.replace(/\/+$/, "").replace(/\.git$/, "");
    return `${scp[1]!.toLowerCase()}/${path}`;
  }

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return `${url.hostname.toLowerCase()}${path.startsWith("/") ? path : `/${path}`}`;
  } catch {
    const path = trimmed.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/, "");
    return path.length > 0 ? path : null;
  }
}

export function repoIdFromText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** One asynchronous `git` lookup per normalized cwd, memoized in-process. */
export function createRepoResolver(deps: ScopeDeps): (cwd: string) => Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? 1500;
  const cache = new Map<string, Promise<string | null>>();

  const run: ScopeRun =
    deps.run ??
    (async (args, cwd) => {
      try {
        const result = await execFileAsync("git", [...args], {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 64 * 1024,
        });
        return { code: 0, stdout: result.stdout };
      } catch (error) {
        const code =
          typeof (error as NodeJS.ErrnoException).code === "number"
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : 1;
        return { code, stdout: "" };
      }
    });

  return (cwd: string): Promise<string | null> => {
    const key = normalizeWorkspacePath(cwd);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<string | null> => {
      const remote = await run(["remote", "get-url", "origin"], key);
      if (remote.code === 0 && remote.stdout.trim().length > 0) {
        const normalized = normalizeRemoteUrl(remote.stdout);
        if (normalized !== null) return repoIdFromText(normalized);
      }

      const root = await run(["rev-parse", "--show-toplevel"], key);
      if (root.code === 0 && root.stdout.trim().length > 0) {
        return repoIdFromText(normalizeWorkspacePath(root.stdout.trim()));
      }
      return null;
    })();

    cache.set(key, pending);
    return pending;
  };
}

/** The room's one lesson scope: repository identity first, workspace second. */
export function candidateScope(cwd: string, repoId: string | null): string {
  return repoId !== null ? repoScope(repoId) : workspaceScope(cwd);
}
