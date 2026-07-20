// `ework-aio config <subcommand>` — read/change runtime .env keys.
//
// Subcommands:
//   list                          Show all settable keys + current values
//   get <KEY>                     Print one key's value
//   set <KEY> <VALUE>             Write to .env, then restart affected service
//                                 (use --no-restart to skip)
//   restart <web|daemon|both>     Restart one or both services
//
// Allow-list: only keys in SETTABLE_KEYS (src/types.ts) are exposed.
// Secrets, DB paths, and the web<->daemon contract keys are deliberately
// excluded — those need `rm .env && ework-aio install` to regenerate.
//
// Cross-link propagation: when WORK_PORT changes, the daemon .env's
// GITEA_URL is rewritten; when DAEMON_PORT changes, the web .env's
// WORK_DAEMON_WEBHOOK_URL is rewritten. Both services then restart.

import fs from "node:fs";
import path from "node:path";
import { Logger, InstallError } from "../log.ts";
import { resolvePaths } from "../paths.ts";
import { parseEnvFile, patchEnvKey } from "../env.ts";
import { SECRET_ENV_VARS } from "../config.ts";
import {
  SETTABLE_KEYS,
  findSettableKey,
  serviceForKey,
  type GlobalOptions,
  type ServiceTarget,
} from "../types.ts";
import { runRestart } from "./lifecycle.ts";

function envFileForService(
  svc: "web" | "daemon",
  paths: ReturnType<typeof resolvePaths>,
): string {
  return svc === "web" ? paths.webEnvFile : paths.daemonEnvFile;
}

async function readEnvKey(envFile: string, key: string): Promise<string | null> {
  try {
    const content = await Bun.file(envFile).text();
    const v = parseEnvFile(content).entries.get(key);
    return v !== undefined ? v : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function configList(opts: GlobalOptions, logger: Logger): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: opts.useSystemd });
  logger.hr();
  logger.log("Settable config keys");
  logger.hr();
  logger.log(`  ${"KEY".padEnd(28)} ${"SERVICE".padEnd(8)} VALUE`);
  for (const entry of SETTABLE_KEYS) {
    const envFile = envFileForService(entry.service, paths);
    let val = await readEnvKey(envFile, entry.key);
    if (val === null) val = "(unset)";
    logger.log(`  ${entry.key.padEnd(28)} ${entry.service.padEnd(8)} ${val}`);
  }
  logger.hr();
  logger.log(`Use ${logger.bold("config set <KEY> <VALUE>")} to change a key.`);
}

export async function configGet(
  opts: GlobalOptions,
  logger: Logger,
  key: string,
): Promise<void> {
  const entry = findSettableKey(key);
  if (!entry) {
    throw new InstallError(
      `Key '${key}' is not settable. Run 'ework-aio config list' for the allow-list.`,
    );
  }
  if (SECRET_ENV_VARS.has(key)) {
    throw new InstallError(
      `Key '${key}' is a secret — use 'rm .env && ework-aio install' to regenerate.`,
    );
  }
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: opts.useSystemd });
  const envFile = envFileForService(entry.service, paths);
  const val = await readEnvKey(envFile, key);
  if (val === null) {
    logger.warn(`${key} is not currently set in ${envFile}`);
    return;
  }
  process.stdout.write(`${val}\n`);
}

export async function configSet(
  opts: GlobalOptions,
  logger: Logger,
  key: string,
  value: string,
): Promise<void> {
  const entry = findSettableKey(key);
  if (!entry) {
    throw new InstallError(
      `Key '${key}' is not settable. Run 'ework-aio config list' for the allow-list.`,
    );
  }
  if (SECRET_ENV_VARS.has(key)) {
    throw new InstallError(
      `Key '${key}' is a secret — use 'rm .env && ework-aio install' to regenerate.`,
    );
  }

  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: opts.useSystemd });
  const envFile = envFileForService(entry.service, paths);

  logger.log(`setting ${key}=${value} in ${envFile}`);
  await patchEnvKey(envFile, key, value);
  logger.ok(`${key} updated`);

  if (entry.propagate) {
    const targetFile = envFileForService(entry.propagate.targetService, paths);
    const newVal = entry.propagate.template(value);
    logger.log(`propagating to ${entry.propagate.targetService} (${entry.propagate.targetKey})`);
    await patchEnvKey(targetFile, entry.propagate.targetKey, newVal);
    logger.ok(`${entry.propagate.targetService} .env updated`);
  }

  if (opts.noRestart) {
    const target = serviceForKey(key) ?? "both";
    logger.warn(`--no-restart: changes saved but service not reloaded. Run 'ework-aio config restart ${target}' to apply.`);
    return;
  }

  const target: ServiceTarget = serviceForKey(key) ?? "both";
  logger.log(`restarting ${target}...`);
  await runRestart(opts, logger, target);
}

export async function configRestart(
  opts: GlobalOptions,
  logger: Logger,
  target: ServiceTarget,
): Promise<void> {
  await runRestart(opts, logger, target);
}

export interface ConfigArgs {
  subcommand: "list" | "get" | "set" | "restart" | "help";
  key?: string;
  value?: string;
  target?: ServiceTarget;
}

export async function runConfig(
  opts: GlobalOptions,
  logger: Logger,
  args: ConfigArgs,
): Promise<void> {
  switch (args.subcommand) {
    case "list":
      await configList(opts, logger);
      return;
    case "get":
      if (!args.key) throw new InstallError("Usage: ework-aio config get <KEY>");
      await configGet(opts, logger, args.key);
      return;
    case "set":
      if (!args.key || args.value === undefined) {
        throw new InstallError("Usage: ework-aio config set <KEY> <VALUE>");
      }
      await configSet(opts, logger, args.key, args.value);
      return;
    case "restart":
      await configRestart(opts, logger, args.target ?? "both");
      return;
    case "help":
      printConfigHelp(logger);
      return;
  }
}

export function printConfigHelp(logger: Logger): void {
  logger.log(`ework-aio config <subcommand>`);
  logger.log(``);
  logger.log(`Subcommands:`);
  logger.log(`  list                          List all settable keys + current values`);
  logger.log(`  get <KEY>                     Print current value of one key`);
  logger.log(`  set <KEY> <VALUE>             Set a key in .env, then restart the affected`);
  logger.log(`                                service (unless --no-restart is given)`);
  logger.log(`  restart <web|daemon|both>     Restart one or both services`);
  logger.log(``);
  logger.log(`Examples:`);
  logger.log(`  ework-aio config list`);
  logger.log(`  ework-aio config get WORK_PORT`);
  logger.log(`  ework-aio config set WORK_PORT 8080`);
  logger.log(`  ework-aio config set WORK_TRANSLATE_URL http://127.0.0.1:8000/v1 --no-restart`);
  logger.log(`  ework-aio config restart both`);
  logger.log(``);
  logger.log(`Note: changing WORK_PORT or DAEMON_PORT also rewrites the cross-link the other`);
  logger.log(`service uses, and restarts both. Secrets and DB paths are not settable here —`);
  logger.log(`rerun \`ework-aio install\` (with \`rm .env\` first if you need new tokens).`);
}
