// Detached process management (PID-file mode).
//
// Replaces bash `setsid nohup <cmd> & echo $! > pidfile; disown`.
// Uses node:child_process.spawn with detached:true + child.unref() so the
// parent can exit without taking the child down. stdio is redirected to a
// log file so we don't lose stdout/stderr after parent exit.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface StartProcessOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile: string;
  pidFile: string;
}

export interface StartProcessResult {
  pid: number;
}

export class PidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PidFileError";
  }
}

export async function startProcess(opts: StartProcessOptions): Promise<StartProcessResult> {
  await fs.promises.mkdir(path.dirname(opts.logFile), { recursive: true });
  await fs.promises.mkdir(path.dirname(opts.pidFile), { recursive: true });

  // sync open — Bun's async FileHandle has a finalizer that closes the fd
  // when GC'd, which can race with the child inheriting it via stdio.
  // openSync returns a raw fd we own; spawn() dups it for the child.
  const logFd = fs.openSync(opts.logFile, "a", 0o644);

  let child: ChildProcess;
  try {
    child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } catch (err) {
    fs.closeSync(logFd);
    throw new PidFileError(`Failed to spawn ${opts.cmd}: ${(err as Error).message}`);
  }

  // Bun/node:spawn returns a ChildProcess even when the binary doesn't
  // exist (ENOENT) — child.pid stays undefined and an 'error' event is
  // emitted on next tick. Without a handler the event becomes an
  // uncaughtException that takes down the test runner (and on long-running
  // ework-aio, the install). The no-pid check below catches this case
  // synchronously; this handler suppresses the redundant async 'error'.
  child.on("error", () => { /* handled via pid check below */ });

  if (typeof child.pid !== "number") {
    // S-2: logFd was opened above; we own it until spawn() inherits it
    // via stdio. On the no-pid failure path the child didn't actually
    // take over the fd, so we must close it before throwing — otherwise
    // the fd leaks until process exit (and on long-running installs
    // holding the log file open blocks log rotation).
    fs.closeSync(logFd);
    throw new PidFileError(`Spawned ${opts.cmd} but no pid was assigned`);
  }

  const pid = child.pid;

  child.unref();

  fs.closeSync(logFd);

  await writePidFileAtomic(opts.pidFile, pid);

  return { pid };
}

export async function writePidFileAtomic(pidFile: string, pid: number): Promise<void> {
  const dir = path.dirname(pidFile);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.pid.tmp.${process.pid}.${Date.now()}`);
  await fs.promises.writeFile(tmp, `${pid}\n`, { mode: 0o644 });
  try {
    await fs.promises.rename(tmp, pidFile);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readPidFile(pidFile: string): Promise<number | null> {
  try {
    const content = await fs.promises.readFile(pidFile, "utf8");
    const pid = parseInt(content.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    // signal 0 = existence check, no actual signal sent
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;   // No such process
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;    // Exists but not ours
    throw err;
  }
}

export async function stopProcess(
  pidFile: string,
  opts: { graceMs?: number; sigkillAfter?: boolean } = {},
): Promise<{ pid: number; killed: boolean; timedOut: boolean }> {
  const graceMs = opts.graceMs ?? 5000;
  const pid = await readPidFile(pidFile);
  if (pid === null) {
    throw new PidFileError(`PID file ${pidFile} not found or empty`);
  }
  if (!isProcessRunning(pid)) {
    // Stale pidfile; clean up.
    await fs.promises.unlink(pidFile).catch(() => {});
    return { pid, killed: false, timedOut: false };
  }

  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      await fs.promises.unlink(pidFile).catch(() => {});
      return { pid, killed: true, timedOut: false };
    }
    await sleep(100);
  }

  if (opts.sigkillAfter === false) {
    return { pid, killed: false, timedOut: true };
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      await fs.promises.unlink(pidFile).catch(() => {});
      return { pid, killed: true, timedOut: true };
    }
    throw err;
  }
  await fs.promises.unlink(pidFile).catch(() => {});
  return { pid, killed: true, timedOut: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
