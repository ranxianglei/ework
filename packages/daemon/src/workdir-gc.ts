import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Working-directory node_modules GC.
 *
 * Per-issue workdirs nest a full repo clone (worktree) plus an isolated
 * node_modules. The installs accumulate unboundedly across hundreds of
 * closed issues — the fleet's dominant disk consumer. Strategy (user
 * decision 2026-09-11): node_modules older than the TTL are deleted while
 * no live opencode process is working inside the repo; the next spawn on
 * that issue simply re-runs its install. Worktrees/git objects stay.
 */

const MAX_WALK_DEPTH = 4;

async function collectNodeModulesDirs(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".refs.git" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules") {
      out.push(p);
      continue;
    }
    await collectNodeModulesDirs(p, depth + 1, out);
  }
}

/** Absolute cwd paths of every live opencode process (busy guard source). */
export async function listBusyOpencodeWorkdirs(): Promise<Set<string>> {
  const busy = new Set<string>();
  const { execFile } = await import("node:child_process");
  const { realpath } = await import("node:fs/promises");
  const pids = await new Promise<string[]>((resolve) => {
    execFile("pgrep", ["-f", "opencode"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? [] : stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    });
  });
  for (const pid of pids) {
    try {
      busy.add(await realpath(`/proc/${pid}/cwd`));
    } catch {
      /* process exited between pgrep and readlink */
    }
  }
  return busy;
}

function isBusy(nodeModulesDir: string, busy: Set<string>): boolean {
  // node_modules sits inside the per-issue repo clone; its parent dir is the
  // repo root a running agent may have as cwd (or any subdir under it).
  const repoRoot = join(nodeModulesDir, "..");
  for (const cwd of busy) {
    if (cwd === repoRoot || cwd.startsWith(repoRoot + "/")) return true;
  }
  return false;
}

export async function purgeStaleNodeModules(
  root: string,
  ttlMs: number,
  busy: Set<string>,
  now = Date.now(),
): Promise<number> {
  if (ttlMs <= 0) return 0;
  const dirs: string[] = [];
  await collectNodeModulesDirs(root, 1, dirs);
  let removed = 0;
  for (const d of dirs) {
    if (isBusy(d, busy)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(d)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < ttlMs) continue;
    try {
      await rm(d, { recursive: true, force: true });
      removed++;
    } catch {
      /* best-effort: next cycle retries */
    }
  }
  return removed;
}
