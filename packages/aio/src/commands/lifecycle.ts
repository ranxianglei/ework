// PID-file mode lifecycle: start / stop / restart / status.
//
// Each command targets a service ("web" | "daemon") or "both". Services
// are detached (startProcess uses spawn+unref) so they survive the CLI's
// exit. PIDs land in <dataDir>/run/<svc>.pid, logs in <dataDir>/run/<svc>.log.
//
// `status` reports per-service: PID, alive?, port (if listed in .env),
// and a one-line fetch probe (so users see "✓ listening" vs "✗ not
// responding" without having to curl themselves).

import { Logger, InstallError } from "../log.ts";
import { resolvePaths, type PathConfig } from "../paths.ts";
import {
  startProcess,
  stopProcess,
  readPidFile,
  isProcessRunning,
} from "../pidfile.ts";
import { parseEnvFile } from "../env.ts";
import { resolveCommand } from "../preflight.ts";
import type { GlobalOptions, ServiceTarget } from "../types.ts";

interface ServicePaths {
  bin: string;
  dataDir: string;
  envFile: string;
  pidFile: string;
  logFile: string;
  portKey: string | null;
}

function servicePaths(paths: PathConfig, svc: "web" | "daemon"): ServicePaths {
  if (svc === "web") {
    return {
      bin: "ework-web",
      dataDir: paths.webDataDir,
      envFile: paths.webEnvFile,
      pidFile: paths.webPidFile,
      logFile: paths.webLogFile,
      portKey: "WORK_PORT",
    };
  }
  return {
    bin: "ework-daemon",
    dataDir: paths.daemonDataDir,
    envFile: paths.daemonEnvFile,
    pidFile: paths.daemonPidFile,
    logFile: paths.daemonLogFile,
    portKey: "DAEMON_PORT",
  };
}

async function loadEnv(envFile: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const content = await Bun.file(envFile).text();
    const parsed = parseEnvFile(content);
    for (const [k, v] of parsed.entries) env[k] = v;
  } catch {
    // missing .env → fall back to process.env only
  }
  return env;
}

async function startOne(
  svc: "web" | "daemon",
  paths: PathConfig,
  logger: Logger,
): Promise<boolean> {
  const sp = servicePaths(paths, svc);
  const binPath = resolveCommand(sp.bin);
  if (!binPath) {
    throw new InstallError(`${sp.bin} not found on PATH — install with: npm install -g ${sp.bin}`);
  }
  const existingPid = await readPidFile(sp.pidFile);
  if (existingPid !== null && isProcessRunning(existingPid)) {
    logger.log(`ework-${svc} already running (pid ${existingPid})`);
    return false;
  }
  const env = await loadEnv(sp.envFile);
  const { pid } = await startProcess({
    cmd: binPath,
    args: [],
    cwd: sp.dataDir,
    env,
    logFile: sp.logFile,
    pidFile: sp.pidFile,
  });
  logger.ok(`ework-${svc} started (pid ${pid}, log ${sp.logFile})`);
  return true;
}

async function stopOne(svc: "web" | "daemon", paths: PathConfig, logger: Logger): Promise<boolean> {
  const sp = servicePaths(paths, svc);
  try {
    const result = await stopProcess(sp.pidFile, { graceMs: 5000, sigkillAfter: true });
    if (result.killed) {
      logger.ok(`ework-${svc} stopped (pid ${result.pid}${result.timedOut ? ", SIGKILL after timeout" : ""})`);
    } else {
      logger.log(`ework-${svc} was not running (stale pidfile cleaned)`);
    }
    return result.killed;
  } catch (err) {
    if (err instanceof Error && /not found or empty/.test(err.message)) {
      logger.log(`ework-${svc} not running (no pidfile at ${sp.pidFile})`);
      return false;
    }
    throw err;
  }
}

function targets(target: ServiceTarget): Array<"web" | "daemon"> {
  return target === "both" ? ["web", "daemon"] : [target];
}

export async function runStart(
  opts: GlobalOptions,
  logger: Logger,
  target: ServiceTarget,
): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });
  for (const svc of targets(target)) {
    await startOne(svc, paths, logger);
  }
}

export async function runStop(
  opts: GlobalOptions,
  logger: Logger,
  target: ServiceTarget,
): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });
  for (const svc of targets(target)) {
    await stopOne(svc, paths, logger);
  }
}

export async function runRestart(
  opts: GlobalOptions,
  logger: Logger,
  target: ServiceTarget,
): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });
  for (const svc of targets(target)) {
    await stopOne(svc, paths, logger);
    await startOne(svc, paths, logger);
  }
}

export interface StatusEntry {
  svc: "web" | "daemon";
  pid: number | null;
  alive: boolean;
  port: number | null;
  listening: boolean | null;
}

export async function runStatus(opts: GlobalOptions, logger: Logger): Promise<StatusEntry[]> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });

  logger.hr();
  logger.log("ework-aio status (PID-file mode)");
  logger.hr();

  const entries: StatusEntry[] = [];
  for (const svc of ["web", "daemon"] as const) {
    const sp = servicePaths(paths, svc);
    const pid = await readPidFile(sp.pidFile);
    const alive = pid !== null && isProcessRunning(pid);

    let port: number | null = null;
    try {
      const content = await Bun.file(sp.envFile).text();
      const portStr = parseEnvFile(content).entries.get(sp.portKey ?? "");
      if (portStr) port = Number.parseInt(portStr, 10) || null;
    } catch {
      // missing .env → no port
    }

    let listening: boolean | null = null;
    if (port !== null) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/login`, { method: "GET" });
        listening = r.status < 500;
      } catch {
        listening = false;
      }
    }

    entries.push({ svc, pid, alive, port, listening });

    const pidStr = pid === null ? "—" : `pid ${pid}`;
    const aliveStr = alive ? "✓ running" : "✗ not running";
    const portStr = port === null ? "(no port in .env)" : `:${port}`;
    const listenStr = listening === null ? "" : listening ? " ✓ listening" : " ✗ not responding";
    logger.log(`  ework-${svc.padEnd(8)} ${pidStr.padEnd(10)} ${aliveStr}  ${portStr}${listenStr}`);
  }
  logger.hr();
  return entries;
}
