// `ework-aio env` — print resolved paths (no secrets). Useful for users
// to find where data, .env files, and the bot token live without grepping.

import { Logger } from "../log.ts";
import { resolvePaths } from "../paths.ts";
import type { GlobalOptions } from "../types.ts";

export async function runEnv(opts: GlobalOptions, logger: Logger): Promise<void> {
  const paths = resolvePaths({
    dataDir: opts.dataDir,
    scope: opts.scope,
    useSystemd: opts.useSystemd,
  });

  logger.hr();
  logger.log("ework-aio paths");
  logger.hr();
  logger.log(`  data dir      : ${paths.dataDir}`);
  logger.log(`  web env       : ${paths.webEnvFile}`);
  logger.log(`  daemon env    : ${paths.daemonEnvFile}`);
  logger.log(`  bot token     : ${paths.botTokenFile}`);
  logger.log(`  opencode cfg  : ${paths.opencodeConfigFile}`);
  logger.log(`  scope         : ${opts.scope}`);
  logger.log(`  mode          : ${opts.useSystemd ? "systemd" : "PID-file"}`);
  logger.log(`  web unit      : ${paths.webUnitFile ?? "(not used)"}`);
  logger.log(`  daemon unit   : ${paths.daemonUnitFile ?? "(not used)"}`);
}
