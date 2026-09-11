import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Logger, InstallError } from "../log.ts";
import type { GlobalOptions } from "../types.ts";

function readInstalledVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readNpmLatestVersion(): string | null {
  const r = spawnSync("npm", ["view", "ework-aio@latest", "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 10_000,
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

export async function runUpgrade(opts: GlobalOptions, logger: Logger): Promise<void> {
  logger.hr();
  logger.log("ework-aio upgrade");
  logger.hr();

  const before = readInstalledVersion();
  const latest = readNpmLatestVersion();
  if (latest && latest === before) {
    logger.log(`already at latest version (${before})`);
  }

  logger.log("pulling latest ework-aio from npm...");
  const result = spawnSync("npm", ["install", "-g", "ework-aio@latest"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ?? "(no stderr)";
    throw new InstallError(`npm install -g ework-aio@latest failed:\n${stderr}`);
  }

  const after = readInstalledVersion();
  if (after === before) {
    logger.warn(
      `version unchanged (${before}) — npm registry may not have propagated yet, retry in 30s`
    );
  } else {
    logger.ok(`ework-aio updated ${before} → ${after}`);
  }

  // Re-exec as a fresh process so the NEW code resolves bundled deps.
  // The current process still holds the old version in memory.
  logger.log("restarting services with new version...");
  const restartResult = spawnSync("ework-aio", ["restart", ...restartFlags(opts)], {
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
  });
  if (restartResult.status !== 0) {
    throw new InstallError("restart after upgrade failed — run 'ework-aio restart' manually");
  }
  logger.ok("upgrade complete");
}

function restartFlags(opts: GlobalOptions): string[] {
  const flags: string[] = [];
  if (opts.dataDir) flags.push("--data-dir", opts.dataDir);
  return flags;
}
