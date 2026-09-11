import path from "node:path";
import { mkdirSync } from "node:fs";
import { Logger, InstallError } from "../log.ts";
import { resolvePaths, daemonInstancePaths } from "../paths.ts";
import { parseEnvFile, serializeEnvFile, writeEnvFileAtomic } from "../env.ts";
import { startFromSp, type ServicePaths } from "./lifecycle.ts";
import type { GlobalOptions } from "../types.ts";

export async function runAddDaemon(
  opts: GlobalOptions,
  logger: Logger,
  port?: number,
): Promise<void> {
  const paths = resolvePaths({
    dataDir: opts.dataDir,
    scope: opts.scope,
    useSystemd: false,
  });
  const instances = daemonInstancePaths(paths.dataDir, paths.runDir);
  const primary = instances.find((i) => i.num === 1);
  if (!primary) {
    throw new InstallError(
      `No primary daemon found at ${paths.daemonDataDir}. Run 'ework-aio install' first.`,
    );
  }

  let primaryContent: string;
  try {
    primaryContent = await Bun.file(primary.envFile).text();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InstallError(
        `Primary daemon .env not found at ${primary.envFile}. Run 'ework-aio install' first.`,
      );
    }
    throw err;
  }

  const parsed = parseEnvFile(primaryContent);
  const basePortStr = parsed.entries.get("DAEMON_PORT");
  const basePort = basePortStr ? Number.parseInt(basePortStr, 10) : NaN;
  if (!Number.isFinite(basePort)) {
    throw new InstallError(
      `Primary daemon .env has no valid DAEMON_PORT (got '${basePortStr ?? "<unset>"}')`,
    );
  }
  const newPort = port ?? (basePort + instances.length);

  const nextNum = instances.length + 1;
  const newDataDir = nextNum === 1
    ? paths.daemonDataDir
    : path.join(paths.dataDir, `ework-daemon-${nextNum}`);
  const newEnvFile = path.join(newDataDir, ".env");
  const newPidFile = path.join(paths.runDir, `daemon-${nextNum}.pid`);
  const newLogFile = path.join(paths.runDir, `daemon-${nextNum}.log`);

  mkdirSync(newDataDir, { recursive: true });

  const patchedRaw = parsed.rawLines.map((line) => {
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) return line;
    if (line.slice(0, eqIdx).trim().startsWith("#")) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key === "DAEMON_PORT") {
      return `DAEMON_PORT=${newPort}`;
    }
    if (key === "DAEMON_ENDPOINT") {
      const oldVal = line.slice(eqIdx + 1).trim();
      const host = oldVal.split(":")[0] || "127.0.0.1";
      return `DAEMON_ENDPOINT=${host}:${newPort}`;
    }
    return line;
  });
  const body = serializeEnvFile(
    { entries: parsed.entries, rawLines: patchedRaw },
    [],
  );
  await writeEnvFileAtomic(newEnvFile, body);

  const sp: ServicePaths = {
    bin: "ework-daemon-server",
    pkg: "ework-daemon",
    binRelPath: "bin/ework-daemon-server.js",
    dataDir: newDataDir,
    envFile: newEnvFile,
    pidFile: newPidFile,
    logFile: newLogFile,
    portKey: "DAEMON_PORT",
  };
  const label = `daemon-${nextNum}`;
  await startFromSp(sp, label, logger);
}
