// CLI entry point. Manual arg parser (no commander.js — the constraint is
// no new external deps). Dispatches to command handlers under src/commands/.
//
// Parsing rules:
//   - First positional = subcommand (install/uninstall/status/logs/env/
//     config/start/stop/restart/ps/migrate/backfill-timestamps).
//   - `install systemd` = install with --useSystemd. The literal "systemd"
//     positional after install is the only special case.
//   - Global flags (--data-dir, --port, --user, --system, --yes, etc.) can
//     appear anywhere after the subcommand. `config` consumes its own
//     subcommand position too (list/get/set/restart).
//   - Unknown flags → error. We never silently swallow typos.

import os from "node:os";
import { spawnSync } from "node:child_process";
import { Logger, InstallError, log as defaultLogger } from "./log.ts";
import {
  DEFAULTS,
  type GlobalOptions,
  type ServiceTarget,
} from "./types.ts";
import { runInstall } from "./commands/install.ts";
import { runUninstall } from "./commands/uninstall.ts";
import {
  runStart,
  runStop,
  runRestart,
  runStatus,
} from "./commands/lifecycle.ts";
import { runLogs } from "./commands/logs.ts";
import { runEnv } from "./commands/env.ts";
import {
  runConfig,
  printConfigHelp,
  type ConfigArgs,
} from "./commands/config.ts";

const VERSION = "0.2.5-dev";

const USAGE = `ework-aio <command> [options]

Commands:
  install [systemd] [options]     Install or upgrade the ework stack (default).
                                  Add 'systemd' to also write+enable systemd
                                  units. Without 'systemd', runs in pure
                                  PID-file mode (no systemctl calls).
  uninstall                       Stop services and remove units (data preserved)
  status                          Show service status (PID-file mode)
  logs [web|daemon]               Tail logs (Ctrl+C to stop)
  env                             Print key paths (no secrets)
  config <subcommand>             Read / change runtime config (.env keys)
    config list                   List all settable keys + current values
    config get <KEY>              Print current value of one key
    config set <KEY> <VALUE>      Set a key, then restart affected service
                                  (unless --no-restart is given)
    config restart <web|daemon|both>
                                  Restart one or both services

  start [web|daemon|both]         Start services in PID-file mode (default both)
  stop [web|daemon|both]          Stop services (SIGTERM, 5s grace, then SIGKILL)
  restart [web|daemon|both]       Stop + start
  ps                              Show PID-file mode status (alias for 'status')

  migrate [options]               Migrate issues from a Gitea instance
  backfill-timestamps             Fix timestamps on already-migrated data

Install options:
  systemd                         Also install systemd units + enable them
  --user                          (with systemd) user-level units (default)
  --system                        (with systemd) system-level units (needs sudo)
  --data-dir <path>               Override data directory
                                  (default ~/.local/share/ework-aio)
  --port <n>                      ework-web port (default ${DEFAULTS.workPort})
  --daemon-port <n>               ework-daemon port (default ${DEFAULTS.daemonPort})
  --bot-name <login>              Bot username (default ${DEFAULTS.botName})
  --no-start                      Install but don't start services
  --yes (-y)                      Skip all prompts (use generated defaults)
  --as-user <login>               (sudo only) drop privileges: re-exec install
                                  as <login> after enabling linger
  --allow-root                    (sudo only) override refuse-on-root default

Global options:
  --no-restart                    With 'config set': edit .env but skip restart
  -h, --help                      Show this help
  -v, --version                   Print version
`;

export interface ParsedArgs {
  subcommand: string;
  opts: GlobalOptions;
  positionals: string[];
  configArgs: ConfigArgs;
}

function defaultOpts(): GlobalOptions {
  return {
    workPort: DEFAULTS.workPort,
    daemonPort: DEFAULTS.daemonPort,
    botName: DEFAULTS.botName,
    scope: DEFAULTS.scope,
    useSystemd: false,
    assumeYes: false,
    allowRoot: false,
    noRestart: false,
    noStart: false,
  };
}

// parseArgs: manual argv walk. Returns typed result. Throws InstallError
// on unknown flags / missing values. The shape is stable so tests can
// exercise it without touching process.argv.
export function parseArgs(argv: string[]): ParsedArgs {
  // G1: normalize `--flag=value` (Unix-conventional equals form) into
  // `--flag value` so the rest of the parser only handles the space
  // form. Short flags (-h, -v, -y) don't get this treatment (they never
  // take `=` syntax). Plain `--` (end-of-options marker) and tokens
  // without `--` prefix are left alone.
  const expanded: string[] = [];
  for (const tok of argv) {
    if (tok.length > 3 && tok.startsWith("--") && tok.indexOf("=") > 2) {
      const eqIdx = tok.indexOf("=");
      expanded.push(tok.slice(0, eqIdx), tok.slice(eqIdx + 1));
    } else {
      expanded.push(tok);
    }
  }
  argv = expanded;

  const opts = defaultOpts();
  const positionals: string[] = [];
  const configArgs: ConfigArgs = { subcommand: "list" };
  let inConfig = false;
  let useSystemdFromPositional = false;
  // S-1: track if scope was explicitly chosen. Under EUID=0 we used to
  // silently flip default "user" → "system"; that hid the fact that root
  // can't run user-scope systemd (XDG_RUNTIME_DIR unset). Now: defaulted
  // scope still flips (back-compat), explicit --user under root throws.
  let scopeExplicit = false;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) break;

    // `config` consumes its own positional subcommand.
    if (!inConfig && a === "config" && positionals.length === 0) {
      inConfig = true;
      positionals.push("config");
      i++;
      const peek = (k: number): string | undefined => {
        const v = argv[k];
        return typeof v === "string" && !v.startsWith("-") ? v : undefined;
      };
      // First positional after `config` is its subcommand. If absent or
      // not a recognized subcommand name, fall through to "list" (default)
      // or "help" (if user typed something unknown).
      const sub = peek(i);
      if (sub === undefined) {
        // `config` alone — default to list.
      } else if (sub === "list" || sub === "get" || sub === "set" || sub === "restart" || sub === "help") {
        configArgs.subcommand = sub;
        i++;
        if (sub === "get") {
          const key = peek(i);
          if (key !== undefined) { configArgs.key = key; i++; }
        } else if (sub === "set") {
          const key = peek(i);
          if (key !== undefined) { configArgs.key = key; i++; }
          const value = peek(i);
          if (value !== undefined) { configArgs.value = value; i++; }
        } else if (sub === "restart") {
          // Distinguish "no target given" (default to both) from "typo
          // target given" (reject). Without this, `config restart bogus`
          // silently restarts both services — a real foot-gun in production.
          const next = argv[i];
          if (next === "web" || next === "daemon" || next === "both") {
            configArgs.target = next;
            i++;
          } else if (next !== undefined && !next.startsWith("-")) {
            throw new InstallError(
              `config restart: invalid target '${next}'. Expected: web | daemon | both`,
            );
          }
        }
      } else {
        // Unknown config subcommand — fall through to help.
        configArgs.subcommand = "help";
        i++;
      }
      continue;
    }

    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (a === "-v" || a === "--version") {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }

    // Boolean flags
    if (a === "systemd") {
      useSystemdFromPositional = true;
      i++;
      continue;
    }
    if (a === "--user") { opts.scope = "user"; scopeExplicit = true; i++; continue; }
    if (a === "--system") { opts.scope = "system"; scopeExplicit = true; i++; continue; }
    if (a === "--yes" || a === "-y") { opts.assumeYes = true; i++; continue; }
    if (a === "--allow-root") { opts.allowRoot = true; i++; continue; }
    if (a === "--no-start") { opts.noStart = true; i++; continue; }
    if (a === "--no-restart") { opts.noRestart = true; i++; continue; }

    // Value flags (--flag <value>)
    if (a === "--data-dir") {
      const v = argv[++i];
      if (v === undefined) throw new InstallError("--data-dir requires a value");
      opts.dataDir = v;
      i++;
      continue;
    }
    if (a === "--port") {
      const v = argv[++i];
      if (v === undefined) throw new InstallError("--port requires a value");
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new InstallError(`--port: invalid value '${v}' (must be 1-65535)`);
      }
      opts.workPort = n;
      i++;
      continue;
    }
    if (a === "--daemon-port") {
      const v = argv[++i];
      if (v === undefined) throw new InstallError("--daemon-port requires a value");
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new InstallError(`--daemon-port: invalid value '${v}' (must be 1-65535)`);
      }
      opts.daemonPort = n;
      i++;
      continue;
    }
    if (a === "--bot-name") {
      const v = argv[++i];
      if (v === undefined) throw new InstallError("--bot-name requires a value");
      opts.botName = v;
      i++;
      continue;
    }
    if (a === "--as-user") {
      const v = argv[++i];
      if (v === undefined) throw new InstallError("--as-user requires a value");
      opts.asUser = v;
      i++;
      continue;
    }

    if (a.startsWith("--")) {
      throw new InstallError(`Unknown option: ${a} (try --help)`);
    }

    // Positional (e.g. "install", "web", "daemon", "both")
    positionals.push(a);
    i++;
  }

  if (useSystemdFromPositional) opts.useSystemd = true;

  // S-1: explicit --user under root would silently fail later (systemd
  // user-scope needs XDG_RUNTIME_DIR which root doesn't have). Default
  // scope (no flag) still flips to "system" under root for back-compat.
  if (process.getuid && process.getuid() === 0 && opts.scope === "user") {
    if (scopeExplicit) {
      throw new InstallError(
        "--user cannot be used when running as root: user-scope systemd needs XDG_RUNTIME_DIR which root does not have. " +
        "Either drop privileges (run as a regular user) or use --system.",
      );
    }
    opts.scope = "system";
  }

  // S-10: --port and --daemon-port must differ (otherwise both services
  // fight for the same port and neither binds).
  if (opts.workPort === opts.daemonPort) {
    throw new InstallError(
      `--port and --daemon-port must differ (both are ${opts.workPort})`,
    );
  }

  const subcommand = positionals[0] ?? "install";

  return { subcommand, opts, positionals, configArgs };
}

function parseServiceTarget(arg: string | undefined): ServiceTarget {
  if (arg === undefined || arg === "") return "both";
  if (arg === "web" || arg === "daemon" || arg === "both") return arg;
  throw new InstallError(
    `Invalid service target '${arg}'. Expected: web | daemon | both`,
  );
}

// stripAsUserFlag: return argv without `--as-user <login>` (the flag and
// its value), so the sudo'd child doesn't re-enter handleAsUser and loop.
//
// Iterates by index, NOT Array.filter on value. If the username happens to
// appear in another argument (path component, common word like "install",
// or a --bot-name matching the operator login), filter-on-value would
// silently drop that token and corrupt the child's argv.
export function stripAsUserFlag(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (tok === "--as-user") {
      i++; // also skip the value
      continue;
    }
    out.push(tok);
  }
  return out;
}

// handleAsUser: when invoked with --as-user (typically via sudo), re-exec
// the install as the named user after enabling linger. Skipped if not root
// or no --as-user flag.
function handleAsUser(opts: GlobalOptions, argv: string[]): void {
  if (!opts.asUser) return;
  if (process.getuid && process.getuid() !== 0) {
    throw new InstallError("--as-user requires running as root (use sudo)");
  }
  const target = opts.asUser;

  // Resolve target user's home + uid via getpwnam equivalent (os.userInfo
  // doesn't take a name arg, so we shell out to `id`).
  const idRes = spawnSync("id", ["-u", target], { encoding: "utf8" });
  if (idRes.status !== 0 || !idRes.stdout.trim()) {
    throw new InstallError(`--as-user: user '${target}' not found`);
  }
  const targetUid = Number.parseInt(idRes.stdout.trim(), 10);
  if (!Number.isFinite(targetUid)) {
    throw new InstallError(`--as-user: could not parse uid for '${target}'`);
  }
  if (targetUid === 0) {
    throw new InstallError(`--as-user: target '${target}' is root — use --allow-root instead`);
  }

  // Enable linger so user-level systemd services survive logout.
  const linger = spawnSync("loginctl", ["enable-linger", target], { encoding: "utf8" });
  if (linger.status !== 0) {
    throw new InstallError(
      `Failed to enable linger for '${target}': ${linger.stderr?.trim() ?? ""}. ` +
      `Try: sudo loginctl enable-linger ${target}`,
    );
  }

  // Re-exec as target user.
  const self = process.argv[1]!;
  const newArgs = stripAsUserFlag(argv);
  const result = spawnSync("sudo", ["-u", target, "--login", self, ...newArgs], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== null) process.exit(result.status);
  process.exit(1);
}

// enforceRootGuard: refuse install as root unless --allow-root or --as-user.
// Matches install.sh's root guard. Install is the only command that needs
// this — other commands are read-only or scoped to user data.
function enforceRootGuard(opts: GlobalOptions, logger: Logger): void {
  if (!process.getuid || process.getuid() !== 0) return;
  if (opts.asUser) return; // handled above
  if (opts.allowRoot) {
    logger.warn("running install as root with --allow-root — data will live under /root");
    return;
  }
  process.stderr.write(
    `ework-aio install refuses to run as root by default.\n\n` +
    `Why this matters:\n` +
    `  - Data goes under /root/.local/share/ework-aio (unreadable by other users)\n` +
    `  - opencode is searched in root's PATH (usually not installed there)\n` +
    `  - npm packages install to system-wide prefix owned by root\n\n` +
    `Option A (recommended): run as a regular user.\n` +
    `  npm config set prefix '~/.local'\n` +
    `  npm install -g ework-aio\n` +
    `  ework-aio install\n\n` +
    `Option B: install with sudo but target a regular user.\n` +
    `  sudo ework-aio install --as-user ${os.userInfo().username}\n\n` +
    `Option C: really install as root.\n` +
    `  sudo ework-aio install --allow-root\n`,
  );
  process.exit(1);
}

// main: parse + dispatch. Returns exit code.
export async function main(
  argv: string[],
  logger: Logger = defaultLogger,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof InstallError) {
      logger.error(err.message);
      return err.code;
    }
    throw err;
  }

  const { subcommand, opts, positionals, configArgs } = parsed;

  // --as-user triggers a re-exec; this never returns.
  if (opts.asUser && (subcommand === "install" || subcommand === undefined)) {
    handleAsUser(opts, argv);
    return 1;
  }

  try {
    switch (subcommand) {
      case "install": {
        enforceRootGuard(opts, logger);
        await runInstall(opts, logger);
        return 0;
      }
      case "uninstall": {
        await runUninstall(opts, logger);
        return 0;
      }
      case "status":
      case "ps": {
        await runStatus(opts, logger);
        return 0;
      }
      case "logs": {
        const svc = positionals[1] === "daemon" ? "daemon" : "web";
        await runLogs(opts, logger, svc);
        return 0;
      }
      case "env": {
        await runEnv(opts, logger);
        return 0;
      }
      case "config": {
        if (configArgs.subcommand === "help") {
          printConfigHelp(logger);
          return 0;
        }
        await runConfig(opts, logger, configArgs);
        return 0;
      }
      case "start": {
        const target = parseServiceTarget(positionals[1]);
        await runStart(opts, logger, target);
        return 0;
      }
      case "stop": {
        const target = parseServiceTarget(positionals[1]);
        await runStop(opts, logger, target);
        return 0;
      }
      case "restart": {
        const target = parseServiceTarget(positionals[1]);
        await runRestart(opts, logger, target);
        return 0;
      }
      case "migrate": {
        return runDelegateScript("migrate-from-gitea.ts", argv.slice(1));
      }
      case "backfill-timestamps": {
        return runDelegateScript("backfill-timestamps.ts", argv.slice(1));
      }
      default:
        logger.error(`Unknown command: ${subcommand} (try --help)`);
        return 1;
    }
  } catch (err) {
    if (err instanceof InstallError) {
      logger.error(err.message);
      return err.code;
    }
    logger.error(`unexpected error: ${(err as Error).message}`);
    logger.error((err as Error).stack ?? "");
    return 1;
  }
}

// runDelegateScript: hand off to a sibling TS script via bun. Used for
// migrate + backfill-timestamps which live in scripts/ and have their own
// arg surfaces we don't want to absorb into cli.ts.
function runDelegateScript(scriptName: string, args: string[]): number {
  const scriptPath = new URL(`../scripts/${scriptName}`, import.meta.url).pathname;
  const result = spawnSync("bun", [scriptPath, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  if (result.status !== null) return result.status;
  return 1;
}

// Entry-point is bin/ework-aio only. Tests import main() directly.
