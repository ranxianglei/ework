import { execFileSync } from "node:child_process";
import { readdir, stat, rm, realpath } from "node:fs/promises";
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

/**
 * Full issue-workdir GC.
 *
 * purgeStaleNodeModules only reclaims installs; the checkout/worktree itself
 * (including .git) was never reclaimed, so closed issues accumulated 36GB+ of
 * dead workdirs until the disk filled up (incident 2026-09-17: ENOSPC killed
 * spawns and took the whole fleet down). This deletes entire per-issue
 * workdirs whose effective mtime is older than ttlMs, skipping anything in
 * protectedDirs (running sessions / live process cwds).
 *
 * Layout assumption: <root>/<owner>--<repo>/<issueId>/<sessionName> (the
 * default RecloneStrategy template). Custom workdirTemplates that deviate
 * from this shape are left alone — the node_modules pass still covers them.
 */

/** Max of the dir's own mtime and its immediate children's mtimes. */
async function effectiveMtimeMs(dir: string): Promise<number | null> {
  let newest = 0;
  const touch = async (p: string): Promise<void> => {
    try {
      const s = await stat(p);
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    } catch { /* entry vanished mid-walk */ }
  };
  await touch(dir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    await touch(join(dir, e.name));
  }
  return newest > 0 ? newest : null;
}

function isProtected(issueDirReal: string, protectedDirs: Set<string>): boolean {
  if (protectedDirs.has(issueDirReal)) return true;
  for (const p of protectedDirs) {
    // p inside the issue dir (a live session workdir), or the issue dir
    // under an ancestor that is itself protected.
    if (p.startsWith(issueDirReal + "/") || issueDirReal.startsWith(p + "/")) return true;
  }
  return false;
}

export async function purgeStaleWorkdirs(
  root: string,
  ttlMs: number,
  protectedDirs: Iterable<string>,
  now = Date.now(),
): Promise<number> {
  if (ttlMs <= 0) return 0;
  const protectedSet = new Set<string>();
  for (const p of protectedDirs) {
    try {
      protectedSet.add(await realpath(p));
    } catch { /* already gone — nothing to protect */ }
  }
  let repoEntries;
  try {
    repoEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of repoEntries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue; // skips .refs.git etc.
    const repoDir = join(root, e.name);
    let issueEntries;
    try {
      issueEntries = await readdir(repoDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ie of issueEntries) {
      if (!ie.isDirectory() || ie.name.startsWith(".")) continue;
      const issueDir = join(repoDir, ie.name);
      let issueDirReal: string;
      try {
        issueDirReal = await realpath(issueDir);
      } catch {
        continue;
      }
      if (isProtected(issueDirReal, protectedSet)) continue;
      const mtimeMs = await effectiveMtimeMs(issueDir);
      if (mtimeMs === null || now - mtimeMs < ttlMs) continue;
      try {
        await rm(issueDir, { recursive: true, force: true });
        removed++;
      } catch { /* best-effort: next cycle retries */ }
    }
  }
  return removed;
}

/**
 * Free space in MB on the filesystem holding `path`, or null when it cannot
 * be measured (no df binary, permission errors, timeout). Callers must treat
 * null as "unknown → do not block". Bun has no statfs binding, so we shell
 * out like listBusyOpencodeWorkdirs does with pgrep; df -P gives POSIX
 * single-line output whose 4th column is 1K blocks available to unprivileged
 * users.
 */
export function freeSpaceMb(path: string): number | null {
  try {
    const out = execFileSync("df", ["-kP", path], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim().split("\n").pop()?.trim();
    const availKb = Number(out?.split(/\s+/)[3]);
    if (!out || !Number.isFinite(availKb)) return null;
    return Math.floor(availKb / 1024);
  } catch {
    return null;
  }
}

/** Spawn watermark decision: block only when measured AND below floor. */
export function shouldBlockSpawn(freeMb: number | null, minFreeMb: number): boolean {
  if (minFreeMb <= 0 || freeMb === null) return false;
  return freeMb < minFreeMb;
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
