// .env file read / write / preserve / forward-fill.
//
// The v0.1.17 bug we're regressing against: install.sh preserved existing
// .env files verbatim, never injecting schema-required keys that were
// missing. When ework-web's Zod schema grew new required fields, old .env
// files crashed on next startup. fix(install): forward-fill missing
// schema-required keys (bc6b065) was the bash patch; this is the TS port.

import fs from "node:fs";
import path from "node:path";
import { keysForFile, type EnvFile, type InstallContext } from "./config.ts";

export interface EnvMap {
  // Preserves insertion order, matching how .env is read + written.
  readonly entries: ReadonlyMap<string, string>;
}

export interface ForwardFillResult {
  // Keys that were added (envVar names).
  added: string[];
  // Final map after merge.
  merged: Map<string, string>;
}

// parseEnvFile: read a .env file into an ordered map. Format:
//   KEY=value        → entry
//   KEY="value"      → entry, quotes stripped
//   # comment        → skipped (preserved on write via rawLines)
//   <blank>          → skipped (preserved on write via rawLines)
// Malformed lines are skipped with a warning (caller decides whether to fail).
export interface ParsedEnvFile {
  entries: Map<string, string>;
  // Raw lines preserved in original order, for writeback that doesn't
  // disturb user comments / formatting. New keys are appended after the
  // last non-blank non-comment line.
  rawLines: string[];
}

export function parseEnvFile(content: string): ParsedEnvFile {
  const entries = new Map<string, string>();
  const rawLines = content.split(/\r?\n/);
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1);
    // Strip matching surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) entries.set(key, value);
  }
  return { entries, rawLines };
}

// forwardFill: given a parsed .env and an InstallContext, ensure every
// required key for the given file (web or daemon) is present. Missing
// keys are appended to rawLines + merged. Existing keys are NEVER touched.
export function forwardFill(
  parsed: ParsedEnvFile,
  file: EnvFile,
  ctx: InstallContext,
): ForwardFillResult {
  const added: string[] = [];
  const merged = new Map(parsed.entries);

  for (const spec of keysForFile(file)) {
    if (merged.has(spec.envVar)) continue;
    const value = spec.generate(ctx);
    merged.set(spec.envVar, value);
    added.push(spec.envVar);
  }

  return { added, merged };
}

// serializeEnvFile: write a map back to .env format, preserving raw lines
// for keys that already existed and appending new keys at the end.
export function serializeEnvFile(parsed: ParsedEnvFile, added: Array<{ key: string; value: string }>): string {
  const out: string[] = [...parsed.rawLines];
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last === undefined || last.trim() !== "") break;
    out.pop();
  }

  if (added.length > 0) {
    if (out.length > 0) {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "") out.push("");
    }
    const now = new Date().toISOString();
    out.push(`# ework-aio forward-fill at ${now}`);
    for (const { key, value } of added) {
      out.push(`${key}=${value}`);
    }
  }
  return out.join("\n") + "\n";
}

// readEnvFile: read + parse, return null if file doesn't exist.
export async function readEnvFile(filePath: string): Promise<ParsedEnvFile | null> {
  try {
    const content = await Bun.file(filePath).text();
    return parseEnvFile(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// writeEnvFileAtomic: write .env via temp file + rename, mode 0600.
// Atomic so a crash mid-write doesn't leave a corrupt .env.
export async function writeEnvFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.env.tmp.${process.pid}.${Date.now()}`);
  await fs.promises.writeFile(tmp, content, { mode: 0o600 });
  try {
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// ensureEnvFile: top-level entry for write_web_env / write_daemon_env.
// Reads existing .env (if any), forward-fills missing keys, writes back
// atomically. Returns the list of keys that were added.
export interface EnsureEnvOptions {
  file: EnvFile;
  filePath: string;
  ctx: InstallContext;
  // If true and file doesn't exist, generate fresh values for ALL keys
  // (not just required ones). Default true.
  freshIfMissing?: boolean;
}

export async function ensureEnvFile(opts: EnsureEnvOptions): Promise<{ added: string[]; created: boolean }> {
  const existing = await readEnvFile(opts.filePath);
  if (existing === null) {
    // Fresh file: synthesize an empty ParsedEnvFile so forwardFill adds all keys.
    const fresh: ParsedEnvFile = { entries: new Map(), rawLines: [] };
    const result = forwardFill(fresh, opts.file, opts.ctx);
    const now = new Date().toISOString();
    const header = `# Generated by ework-aio at ${now}\n`;
    const body = serializeEnvFile(fresh, result.added.map((key) => ({
      key,
      value: result.merged.get(key) ?? "",
    })));
    await writeEnvFileAtomic(opts.filePath, header + body);
    return { added: result.added, created: true };
  }

  const result = forwardFill(existing, opts.file, opts.ctx);
  if (result.added.length === 0) {
    // Nothing to do — preserve the file untouched.
    return { added: [], created: false };
  }

  const body = serializeEnvFile(existing, result.added.map((key) => ({
    key,
    value: result.merged.get(key) ?? "",
  })));
  await writeEnvFileAtomic(opts.filePath, body);
  return { added: result.added, created: false };
}

// patchEnvKey: rewrite a single key in .env, preserving all other lines,
// then write atomically (temp + rename, mode 0600). Used by config set
// and install.ts (BOT_TOKEN injection after forward-fill).
//
// If the file doesn't exist, it's created with just this key. If the key
// already exists, its value is replaced in-place. Otherwise the key is
// appended after the last non-blank line.
//
// Key matching uses the same tolerance as parseEnvFile: leading/trailing
// whitespace around `=` is accepted (`KEY = value` matches key `KEY`).
// Without this alignment, patch would append a duplicate line instead of
// replacing, and downstream parseEnvFile would silently pick one of the
// two values depending on iteration order.
export async function patchEnvKey(envFile: string, key: string, value: string): Promise<void> {
  let content = "";
  try {
    content = await Bun.file(envFile).text();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = content.split(/\r?\n/);
  let found = false;
  for (const [i, line] of lines.entries()) {
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    // Skip comment lines (parseEnvFile ignores leading '#' too).
    if (line.slice(0, eqIdx).trim().startsWith("#")) continue;
    if (line.slice(0, eqIdx).trim() === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    // Trim trailing blank lines, then append.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(`${key}=${value}`);
  } else {
    // On in-place replace, `content.split(/\r?\n/)` keeps a trailing "" if
    // the file ended with `\n` (the common case). Joining back with "\n"
    // reproduces the trailing "\n", so we'd otherwise double it below.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }
  await writeEnvFileAtomic(envFile, lines.join("\n") + "\n");
}
