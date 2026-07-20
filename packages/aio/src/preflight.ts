import { spawnSync } from "node:child_process";

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
