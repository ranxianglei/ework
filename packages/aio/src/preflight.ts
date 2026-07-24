import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
