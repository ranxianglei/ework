// opencode.json read/write + plugin registration. Replaces jq with
// JSON.parse/stringify. Treats the file as untrusted input — malformed
// JSON throws a typed error, not a raw SyntaxError.

import fs from "node:fs";
import path from "node:path";
import { InstallError } from "./log.ts";

export interface OpencodeConfig {
  // Unknown-key passthrough — preserves fields we don't know about.
  [key: string]: unknown;
  plugins?: Array<string | { name: string; [k: string]: unknown }>;
}

export interface ReadConfigResult {
  config: OpencodeConfig;
  existed: boolean;
}

export async function readConfig(configPath: string): Promise<ReadConfigResult> {
  let content: string;
  try {
    content = await Bun.file(configPath).text();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, existed: false };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new InstallError(
      `${configPath} contains malformed JSON: ${(err as Error).message}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InstallError(
      `${configPath} must be a JSON object at the top level (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }

  return { config: parsed as OpencodeConfig, existed: true };
}

export async function writeConfig(configPath: string, config: OpencodeConfig): Promise<void> {
  const dir = path.dirname(configPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.opencode.json.tmp.${process.pid}.${Date.now()}`);
  const content = JSON.stringify(config, null, 2) + "\n";
  await fs.promises.writeFile(tmp, content, { mode: 0o644 });
  try {
    await fs.promises.rename(tmp, configPath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

function normalizePluginEntry(entry: unknown): string | null {
  // Plugin entries can be either "name" (string) or { name: "...", ...opts }.
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return null;
}

export function hasPlugin(config: OpencodeConfig, pluginName: string): boolean {
  const plugins = config.plugins;
  if (!Array.isArray(plugins)) return false;
  return plugins.some((p) => normalizePluginEntry(p) === pluginName);
}

export function ensurePlugin(config: OpencodeConfig, pluginName: string): { config: OpencodeConfig; added: boolean } {
  if (hasPlugin(config, pluginName)) {
    return { config, added: false };
  }
  const next: OpencodeConfig = { ...config };
  next.plugins = [...(Array.isArray(config.plugins) ? config.plugins : []), pluginName];
  return { config: next, added: true };
}

export function removePlugin(config: OpencodeConfig, pluginName: string): { config: OpencodeConfig; removed: boolean } {
  if (!hasPlugin(config, pluginName)) {
    return { config, removed: false };
  }
  const next: OpencodeConfig = { ...config };
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  next.plugins = plugins.filter((p) => normalizePluginEntry(p) !== pluginName);
  return { config: next, removed: true };
}

export async function ensurePluginInFile(configPath: string, pluginName: string): Promise<{ added: boolean }> {
  const { config } = await readConfig(configPath);
  const result = ensurePlugin(config, pluginName);
  if (!result.added) return { added: false };
  await writeConfig(configPath, result.config);
  return { added: true };
}
