// opencode.json read/write + plugin registration. Replaces jq with
// JSON.parse/stringify. Treats the file as untrusted input — malformed
// JSON throws a typed error, not a raw SyntaxError.

import fs from "node:fs";
import path from "node:path";
import { InstallError } from "./log.ts";

// Per https://opencode.ai/config.json (verified v1.14.x), the top-level
// schema key is "plugin" (singular), an array. Each entry is either a
// string ("opencode-ework@latest") or a 2-tuple [name, options]. The
// schema sets additionalProperties: false at top level, so any other key
// name — including the plausible-looking "plugins" plural — is rejected
// with "Unrecognized key" and breaks every opencode command that parses
// config (export, session list, etc).
//
// v0.2.0-v0.2.3 wrote the WRONG key ("plugins"). On the user's machine
// the result was: install completes, but clicking any session in
// awork-web fails because awork-web calls `opencode export ses_xxx`,
// opencode parses its config first, and aborts with "Unrecognized key:
// plugins". This file now writes the correct key, and the reader
// transparently migrates any legacy "plugins" array into "plugin" so
// reinstall fixes existing broken configs without manual editing.
export interface OpencodeConfig {
  [key: string]: unknown;
  // Accepted entry shapes (we are lenient on read):
  //   - "name@version"     (opencode schema — canonical)
  //   - ["name", {...opts}] (opencode schema — 2-tuple form)
  //   - { name: "..." }     (legacy from earlier ework-aio; opencode
  //                          rejects this, but we preserve through
  //                          read+write so users don't lose data)
  plugin?: Array<string | [string, unknown] | { name: string; [k: string]: unknown }>;
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

  return { config: migrateLegacyPluginsKey(parsed as OpencodeConfig), existed: true };
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

// migrateLegacyPluginsKey: if a config has the v0.2.0-v0.2.3 "plugins"
// (plural) key from our earlier broken installer, merge its contents
// into the correct "plugin" key and drop the bad key. Idempotent — if
// the user re-runs install with the fixed version, their config gets
// healed automatically. Returns the original config object untouched if
// no migration was needed.
function migrateLegacyPluginsKey(config: OpencodeConfig): OpencodeConfig {
  const legacy = config.plugins;
  if (!Array.isArray(legacy)) {
    // Either no legacy key, or it's malformed (not an array). Delete
    // either way so we don't persist an unrecognized key back to disk.
    if ("plugins" in config) {
      const next = { ...config };
      delete next.plugins;
      return next;
    }
    return config;
  }
  const next: OpencodeConfig = { ...config };
  delete next.plugins;
  const canonical = Array.isArray(config.plugin) ? [...config.plugin] : [];
  for (const entry of legacy) {
    const name = normalizePluginEntry(entry);
    if (!name) continue;
    const already = canonical.some((e) => normalizePluginEntry(e) === name);
    if (!already) canonical.push(entry);
  }
  next.plugin = canonical;
  return next;
}

function normalizePluginEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && entry.length >= 1 && typeof entry[0] === "string") {
    return entry[0];
  }
  if (entry !== null && typeof entry === "object") {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return null;
}

export function hasPlugin(config: OpencodeConfig, pluginName: string): boolean {
  const list = config.plugin;
  if (!Array.isArray(list)) return false;
  return list.some((p) => normalizePluginEntry(p) === pluginName);
}

export function ensurePlugin(config: OpencodeConfig, pluginName: string): { config: OpencodeConfig; added: boolean } {
  if (hasPlugin(config, pluginName)) {
    return { config, added: false };
  }
  const next: OpencodeConfig = { ...config };
  next.plugin = [...(Array.isArray(config.plugin) ? config.plugin : []), pluginName];
  return { config: next, added: true };
}

export function removePlugin(config: OpencodeConfig, pluginName: string): { config: OpencodeConfig; removed: boolean } {
  if (!hasPlugin(config, pluginName)) {
    return { config, removed: false };
  }
  const next: OpencodeConfig = { ...config };
  const list = Array.isArray(config.plugin) ? config.plugin : [];
  next.plugin = list.filter((p) => normalizePluginEntry(p) !== pluginName);
  return { config: next, removed: true };
}

export async function ensurePluginInFile(configPath: string, pluginName: string): Promise<{ added: boolean }> {
  const { config } = await readConfig(configPath);
  const result = ensurePlugin(config, pluginName);
  // Always write — readConfig may have migrated a legacy "plugins" key,
  // and we want to persist the corrected shape to disk even if the
  // plugin was already present under the (now-renamed) "plugin" key.
  await writeConfig(configPath, result.config);
  return { added: result.added };
}
