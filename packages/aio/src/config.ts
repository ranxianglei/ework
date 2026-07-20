// Single source of truth for ework-web + ework-daemon .env keys.
//
// Each key has:
//   - envVar:     the literal env var name written to .env
//   - generate(): returns the value to use when forward-filling a missing key
//   - secret?:    true if the value is sensitive (token, secret, password)
//                 — used to redact in `config list` output
//
// The forward-fill principle: when a user re-runs install and we preserve
// their existing .env, we walk this list and append any missing keys with
// freshly generated values. User-set values are NEVER overwritten.
//
// This schema MUST stay in sync with ework-web's src/config.ts (the runtime
// Zod parser). Any new required field added there must be added here too,
// otherwise stale .env files will crash the next start (the v0.1.17 bug).

import { randomBytes } from "node:crypto";
import type { PathConfig } from "./paths.ts";

export type EnvFile = "web" | "daemon";

export interface InstallContext {
  paths: PathConfig;
  workPort: number;
  daemonPort: number;
  botName: string;
  operatorLogin: string;
  // opencode binary path (looked up via preflight)
  opencodeBin: string;
}

export interface EnvKeySpec {
  envVar: string;
  file: EnvFile;
  secret?: boolean;
  generate: (ctx: InstallContext) => string;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

export const WEB_ENV_KEYS: readonly EnvKeySpec[] = [
  { envVar: "WORK_PORT",                   file: "web", generate: (c) => String(c.workPort) },
  { envVar: "WORK_HOST",                   file: "web", generate: () => "127.0.0.1" },
  { envVar: "WORK_TOKEN",                  file: "web", secret: true, generate: () => hex(20) },
  { envVar: "WORK_COOKIE_SECRET",          file: "web", secret: true, generate: () => hex(24) },
  { envVar: "WORK_OPERATOR_LOGIN",         file: "web", generate: (c) => c.operatorLogin },
  { envVar: "WORK_WRITES_ENABLED",         file: "web", generate: () => "true" },
  { envVar: "WORK_DB_PATH",                file: "web", generate: (c) => c.paths.webDbPath },
  { envVar: "WORK_ATTACHMENT_ROOT",        file: "web", generate: (c) => c.paths.webAttachmentRoot },
  { envVar: "WORK_FILE_ROOTS",             file: "web", generate: (c) => `/tmp,${c.paths.dataDir}` },
  { envVar: "WORK_DAEMON_BOT_LOGIN",       file: "web", generate: (c) => c.botName },
  { envVar: "WORK_DAEMON_WEBHOOK_URL",     file: "web", generate: (c) => `http://127.0.0.1:${c.daemonPort}` },
  { envVar: "WORK_DAEMON_WEBHOOK_SECRET",  file: "web", secret: true, generate: () => hex(20) },
] as const;

export const DAEMON_ENV_KEYS: readonly EnvKeySpec[] = [
  { envVar: "DAEMON_ENV",             file: "daemon", generate: () => "production" },
  { envVar: "DAEMON_PORT",            file: "daemon", generate: (c) => String(c.daemonPort) },
  { envVar: "DAEMON_HOST",            file: "daemon", generate: () => "127.0.0.1" },
  { envVar: "DAEMON_DB_PATH",         file: "daemon", generate: (c) => c.paths.daemonDbPath },
  { envVar: "GITEA_URL",              file: "daemon", generate: (c) => `http://127.0.0.1:${c.workPort}` },
  // These tokens come from the bot bootstrap flow — empty placeholder here,
  // filled in by write_daemon_env after PAT is minted.
  { envVar: "GITEA_TOKEN",            file: "daemon", secret: true, generate: () => "" },
  { envVar: "GITEA_WEBHOOK_SECRET",   file: "daemon", secret: true, generate: (c) => hex(20) },
  { envVar: "BOT_USERNAME",           file: "daemon", generate: (c) => c.botName },
  { envVar: "BOT_TOKEN",              file: "daemon", secret: true, generate: () => "" },
  { envVar: "OPENCODE_BINARY",        file: "daemon", generate: (c) => c.opencodeBin },
  { envVar: "OPENCODE_BASE_WORKDIR",  file: "daemon", generate: (c) => c.paths.opencodeWorkdir },
] as const;

export function keysForFile(file: EnvFile): readonly EnvKeySpec[] {
  return file === "web" ? WEB_ENV_KEYS : DAEMON_ENV_KEYS;
}

// Set of env vars that, if missing, would crash ework-web or ework-daemon
// at startup (Zod schema rejects). Used by env.ts forward-fill to log
// which keys were injected.
export const REQUIRED_KEYS: ReadonlySet<string> = new Set([
  ...WEB_ENV_KEYS.map((k) => k.envVar),
  ...DAEMON_ENV_KEYS.map((k) => k.envVar),
]);

// Keys whose value should be redacted in `config list` output.
export const SECRET_ENV_VARS: ReadonlySet<string> = new Set([
  ...WEB_ENV_KEYS.filter((k) => k.secret).map((k) => k.envVar),
  ...DAEMON_ENV_KEYS.filter((k) => k.secret).map((k) => k.envVar),
]);
