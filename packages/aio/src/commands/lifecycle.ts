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
import {
  resolvePaths,
  daemonInstancePaths,
  type PathConfig,
  type DaemonInstance,
} from "../paths.ts";
import {
  startProcess,
  stopProcess,
  readPidFile,
  isProcessRunning,
} from "../pidfile.ts";
import { parseEnvFile } from "../env.ts";
import { resolveCommand, resolveBundledBin } from "../preflight.ts";
import type { GlobalOptions, ServiceTarget } from "../types.ts";

export interface ServicePaths {
  bin: string;
  pkg: string;
  binRelPath: string;
  dataDir: string;
  envFile: string;
  pidFile: string;
  logFile: string;
  portKey: string | null;
}

function servicePaths(paths: PathConfig, svc: "web" | "daemon" | "router"): ServicePaths {
  if (svc === "web") {
    return {
      bin: "ework-web",
      pkg: "ework-web",
      binRelPath: "bin/ework-web.js",
      dataDir: paths.webDataDir,
      envFile: paths.webEnvFile,
      pidFile: paths.webPidFile,
      logFile: paths.webLogFile,
      portKey: "WORK_PORT",
    };
  }
  if (svc === "router") {
    return {
      bin: "ework-router",
      pkg: "ework-router",
      binRelPath: "bin/ework-router.js",
      dataDir: paths.routerDataDir,
      envFile: paths.routerEnvFile,
      pidFile: paths.routerPidFile,
      logFile: paths.routerLogFile,
      portKey: "ROUTER_PORT",
    };
  }
  return {
    bin: "ework-daemon-server",
    pkg: "ework-daemon",
    binRelPath: "bin/ework-daemon-server.js",
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

async function readPort(sp: ServicePaths): Promise<number | null> {
  try {
    const content = await Bun.file(sp.envFile).text();
    const portStr = parseEnvFile(content).entries.get(sp.portKey ?? "");
    if (portStr) return Number.parseInt(portStr, 10) || null;
  } catch {
    // missing .env → no port
  }
  return null;
}

async function readLogTail(logFile: string, maxLines: number): Promise<string | null> {
  try {
    const text = await Bun.file(logFile).text();
    const lines = text.trimEnd().split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch {
    return null;
  }
}

async function startOne(
  svc: "web" | "daemon" | "router",
  paths: PathConfig,
  logger: Logger,
): Promise<boolean> {
  const sp = servicePaths(paths, svc);
  return startFromSp(sp, svc, logger);
}

export async function startFromSp(
  sp: ServicePaths,
  label: string,
  logger: Logger,
): Promise<boolean> {
  const binPath = resolveBundledBin(sp.pkg, sp.binRelPath) ?? resolveCommand(sp.bin);
  if (!binPath) {
    throw new InstallError(`${sp.bin} not found — update with: npm install -g ework-aio@latest`);
  }
  const existingPid = await readPidFile(sp.pidFile);
  if (existingPid !== null && isProcessRunning(existingPid)) {
    logger.log(`ework-${label} already running (pid ${existingPid})`);
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

  await new Promise((r) => setTimeout(r, 1500));
  if (!isProcessRunning(pid)) {
    const tail = await readLogTail(sp.logFile, 10);
    const detail = tail ? `\n${tail}` : "";
    throw new InstallError(`ework-${label} failed to start (pid ${pid} exited within 1.5s)${detail}`);
  }

  const port = await readPort(sp);
  const portStr = port !== null ? `, http://127.0.0.1:${port}` : "";
  logger.ok(`ework-${label} started (pid ${pid}${portStr}, log ${sp.logFile})`);
  return true;
}

async function stopOne(svc: "web" | "daemon" | "router", paths: PathConfig, logger: Logger): Promise<boolean> {
  const sp = servicePaths(paths, svc);
  return stopFromSp(sp, svc, logger);
}

export async function stopFromSp(
  sp: ServicePaths,
  label: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const result = await stopProcess(sp.pidFile, { graceMs: 5000, sigkillAfter: true });
    if (result.killed) {
      logger.ok(`ework-${label} stopped (pid ${result.pid}${result.timedOut ? ", SIGKILL after timeout" : ""})`);
    } else {
      logger.log(`ework-${label} was not running (stale pidfile cleaned)`);
    }
    return result.killed;
  } catch (err) {
    if (err instanceof Error && /not found or empty/.test(err.message)) {
      logger.log(`ework-${label} not running (no pidfile at ${sp.pidFile})`);
      return false;
    }
    throw err;
  }
}

function daemonSpFromInstance(inst: DaemonInstance): ServicePaths {
  return {
    bin: "ework-daemon-server",
    pkg: "ework-daemon",
    binRelPath: "bin/ework-daemon-server.js",
    dataDir: inst.dataDir,
    envFile: inst.envFile,
    pidFile: inst.pidFile,
    logFile: inst.logFile,
    portKey: "DAEMON_PORT",
  };
}

function instanceLabel(num: number): string {
  return num === 1 ? "daemon" : `daemon-${num}`;
}

function iterDaemonInstances(
  paths: PathConfig,
): Array<{ sp: ServicePaths; label: string }> {
  const instances = daemonInstancePaths(paths.dataDir, paths.runDir);
  return instances.map((inst) => ({
    sp: daemonSpFromInstance(inst),
    label: instanceLabel(inst.num),
  }));
}

function targets(target: ServiceTarget): Array<"web" | "daemon" | "router"> {
  if (target === "both") return ["web", "daemon", "router"];
  return [target];
}

function iterTargets(
  paths: PathConfig,
  target: ServiceTarget,
): Array<{ sp: ServicePaths; label: string }> {
  const out: Array<{ sp: ServicePaths; label: string }> = [];
  for (const svc of targets(target)) {
    if (svc === "web") {
      out.push({ sp: servicePaths(paths, "web"), label: "web" });
    } else if (svc === "router") {
      out.push({ sp: servicePaths(paths, "router"), label: "router" });
    } else {
      const insts = iterDaemonInstances(paths);
      if (insts.length === 0) {
        out.push({ sp: servicePaths(paths, "daemon"), label: "daemon" });
      } else {
        out.push(...insts);
      }
    }
  }
  return out;
}

export async function runStart(
  opts: GlobalOptions,
  logger: Logger,
  target: ServiceTarget,
): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });
  for (const { sp, label } of iterTargets(paths, target)) {
    await startFromSp(sp, label, logger);
  }
}

export async function runStop(
  opts: GlobalOptions,
  logger: Logger,
  target: ServiceTarget,
): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });
  for (const { sp, label } of iterTargets(paths, target)) {
    await stopFromSp(sp, label, logger);
  }
}

export async function runRestart(
  opts: GlobalOptions,
  logger: Logger,
  target: ServiceTarget,
): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });
  for (const { sp, label } of iterTargets(paths, target)) {
    await stopFromSp(sp, label, logger);
    await startFromSp(sp, label, logger);
  }
}

export interface StatusEntry {
  svc: string;
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

  const probeTargets: Array<{ sp: ServicePaths; label: string }> = [
    { sp: servicePaths(paths, "web"), label: "web" },
    { sp: servicePaths(paths, "router"), label: "router" },
  ];
  const daemonInsts = iterDaemonInstances(paths);
  if (daemonInsts.length === 0) {
    probeTargets.push({ sp: servicePaths(paths, "daemon"), label: "daemon" });
  } else {
    probeTargets.push(...daemonInsts);
  }

  const entries: StatusEntry[] = [];
  for (const { sp, label } of probeTargets) {
    const pid = await readPidFile(sp.pidFile);
    const alive = pid !== null && isProcessRunning(pid);

    const port = await readPort(sp);
    let listening: boolean | null = null;
    if (port !== null) {
      const probeUrl = label === "web"
        ? `http://127.0.0.1:${port}/login`
        : `http://127.0.0.1:${port}/`;
      try {
        const r = await fetch(probeUrl, { method: "GET" });
        listening = r.status < 500;
      } catch {
        listening = false;
      }
    }

    entries.push({ svc: label, pid, alive, port, listening });

    const pidStr = pid === null ? "—" : `pid ${pid}`;
    const aliveStr = alive ? "✓ running" : "✗ not running";
    const portStr = port === null ? "(no port in .env)" : `:${port}`;
    const listenStr = listening === null ? "" : listening ? " ✓ listening" : " ✗ not responding";
    logger.log(`  ework-${label.padEnd(10)} ${pidStr.padEnd(10)} ${aliveStr}  ${portStr}${listenStr}`);
  }
  logger.hr();
  return entries;
}
