import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./log.ts";

// Root of the ework-aio package itself. Derived from this file's location
// (<root>/src/preflight.ts). Used to resolve bins that ework-aio ships as
// declared dependencies (ework-web, ework-daemon) from our own node_modules,
// so install does not depend on npm having created a global bin symlink.
// Overridable via AIO_PACKAGE_ROOT (for tests / non-standard install prefix).
const DEFAULT_PACKAGE_ROOT = path.join(import.meta.dir, "..");

export interface PreflightResult {
  missing: string[];
  found: Map<string, string>;
  optional: Map<string, string | null>;
}

export interface PreflightOptions {
  optionalCommands?: string[];
}

export function resolveCommand(cmd: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${JSON.stringify(cmd)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // Pass env explicitly — Bun's spawnSync doesn't pick up process.env
    // mutations if env is omitted (unlike Node which inherits at spawn).
    env: process.env,
  });
  if (result.status !== 0) return null;
  const path = result.stdout.trim();
  return path === "" ? null : path;
}

// Resolve a bin that ework-aio ships as a declared dependency, from our own
// node_modules. ework-web / ework-daemon are listed as deps in package.json,
// so they are always bundled. We must use them instead of requiring a global
// PATH bin: npm does not reliably recreate global bin symlinks after
// uninstall+reinstall, which previously made `ework-aio install` wrongly tell
// the user to "install ework-web first" even though it was already bundled
// (B-1). Returns the absolute bin path, or null if not bundled.
export function resolveBundledBin(pkgName: string, binRelPath: string): string | null {
  const root = process.env.AIO_PACKAGE_ROOT || DEFAULT_PACKAGE_ROOT;
  const candidate = path.join(root, "node_modules", pkgName, binRelPath);
  return fs.existsSync(candidate) ? candidate : null;
}

export function checkPreflight(
  required: string[],
  opts: PreflightOptions = {},
): PreflightResult {
  const missing: string[] = [];
  const found = new Map<string, string>();
  const optional = new Map<string, string | null>();

  for (const cmd of required) {
    const path = resolveCommand(cmd);
    if (path === null) missing.push(cmd);
    else found.set(cmd, path);
  }

  for (const cmd of opts.optionalCommands ?? []) {
    optional.set(cmd, resolveCommand(cmd));
  }

  return { missing, found, optional };
}

export const REQUIRED_COMMANDS: readonly string[] = ["bun", "npm", "opencode"];
export const OPTIONAL_COMMANDS: readonly string[] = ["systemctl", "sudo"];

export function isDevRepo(): boolean {
  const pkgRoot = path.resolve(import.meta.dir, "..");
  return fs.existsSync(path.join(pkgRoot, ".git"));
}

// Ensure `ework-aio` is reachable from PATH. npm puts the bin at its own
// global prefix's bin dir, which may differ from every dir on PATH (e.g.
// prefix changed after a node upgrade). Walk PATH in order and, at the
// first writable dir, create/repair a symlink to our actual bin.
//
// Skip when running from a dev checkout (detected via .git dir in package
// root). A dev-repo symlink would shadow the npm global install and pin the
// user to stale bundled deps — exactly the bug where `upgrade` pulls latest
// but `restart` still runs 0.1.0 from the dev repo's node_modules.
export function ensureSelfBinSymlink(logger: Logger): void {
  if (isDevRepo()) return;

  const ourBin = path.resolve(import.meta.dir, "..", "bin", "ework-aio");
  if (!fs.existsSync(ourBin)) return;
  const ourBinReal = fs.realpathSync(ourBin);

  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      continue;
    }

    const target = path.join(dir, "ework-aio");
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        try {
          if (fs.realpathSync(target) === ourBinReal) return;
        } catch {
          // broken symlink — fall through to replace
        }
        fs.unlinkSync(target);
      } else {
        continue; // regular file — don't clobber
      }
    } catch {
      // doesn't exist — fall through to create
    }

    try {
      fs.symlinkSync(ourBin, target);
      logger.ok(`bin symlink: ${target} → ${ourBin}`);
      return;
    } catch {
      continue;
    }
  }
}
