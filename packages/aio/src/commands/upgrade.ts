import { spawnSync } from "node:child_process";
import { Logger, InstallError } from "../log.ts";
import type { GlobalOptions } from "../types.ts";

export async function runUpgrade(opts: GlobalOptions, logger: Logger): Promise<void> {
  logger.hr();
  logger.log("ework-aio upgrade");
  logger.hr();

  logger.log("pulling latest ework-aio from npm...");
  const result = spawnSync("npm", ["install", "-g", "ework-aio@latest"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ?? "(no stderr)";
    throw new InstallError(`npm install -g ework-aio@latest failed:\n${stderr}`);
  }
  logger.ok("ework-aio updated to latest");

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
