// `ework-aio env` — print resolved paths (no secrets). Useful for users
// to find where data, .env files, and the bot token live without grepping.

import fs from "node:fs";
import path from "node:path";
import { Logger } from "../log.ts";
import { resolvePaths } from "../paths.ts";
import type { GlobalOptions } from "../types.ts";

export async function runEnv(opts: GlobalOptions, logger: Logger): Promise<void> {
  const paths = resolvePaths({
    dataDir: opts.dataDir,
    scope: opts.scope,
    useSystemd: opts.useSystemd,
  });

  // install.ts writes the bot PAT to <dataDir>/bot-token OR
  // <dataDir>/bot-token.<botName> when --bot-name isn't the default.
  // paths.botTokenFile only knows the un-suffixed path, so glob for any
  // bot-token* matches in the data dir rather than confidently printing a
  // path that may not exist.
  let botTokenPaths: string[] = [];
  try {
    for (const name of await fs.promises.readdir(paths.dataDir)) {
      if (name === "bot-token" || name.startsWith("bot-token.")) {
        botTokenPaths.push(path.join(paths.dataDir, name));
      }
    }
  } catch {
    // data dir doesn't exist yet — fall through to the un-suffixed default
    // so the user sees what path install.ts WOULD use.
  }
  const botTokenLine = botTokenPaths.length === 0
    ? `${paths.botTokenFile} (not yet created — run ework-aio install)`
    : botTokenPaths.join(", ");

  logger.hr();
  logger.log("ework-aio paths");
  logger.hr();
  logger.log(`  data dir      : ${paths.dataDir}`);
  logger.log(`  web env       : ${paths.webEnvFile}`);
  logger.log(`  daemon env    : ${paths.daemonEnvFile}`);
  logger.log(`  bot token     : ${botTokenLine}`);
  logger.log(`  opencode cfg  : ${paths.opencodeConfigFile}`);
  logger.log(`  scope         : ${opts.scope}`);
  logger.log(`  mode          : ${opts.useSystemd ? "systemd" : "PID-file"}`);
  logger.log(`  web unit      : ${paths.webUnitFile ?? "(not used)"}`);
  logger.log(`  daemon unit   : ${paths.daemonUnitFile ?? "(not used)"}`);
}
