// Shared types for the CLI surface. Kept in a dedicated module so commands
// don't need to import from cli.ts (which would create a cycle: cli imports
// commands, commands import types from cli).
//
// Design note: GlobalOptions is the parsed-argv shape every command receives.
// CLI stays the only place that knows about flag parsing; commands consume
// the typed result.

export type Scope = "user" | "system";

// Which service(s) a command targets. `ps` and `status` use "both";
// `start web`/`stop daemon` use a single target.
export type ServiceTarget = "web" | "daemon" | "both";

export interface GlobalOptions {
  // Install-time knobs (defaults live in src/types.ts DEFAULTS).
  workPort: number;            // --port
  daemonPort: number;          // --daemon-port
  botName: string;             // --bot-name
  scope: Scope;                // --user | --system
  useSystemd: boolean;         // true when invoked as `install systemd`
  assumeYes: boolean;          // --yes / -y
  allowRoot: boolean;          // --allow-root
  asUser?: string;             // --as-user <login> (re-exec target)
  noRestart: boolean;          // --no-restart (config set)
  noStart: boolean;            // --no-start (install)
  // Optional path overrides.
  dataDir?: string;            // --data-dir
}

export const DEFAULTS = {
  workPort: 3002,
  daemonPort: 3101,
  botName: "ework-daemon",
  scope: "user" as Scope,
} as const;

// SETTABLE_KEYS: the allow-list for `config set`. Secrets (WORK_TOKEN,
// *_WEBHOOK_SECRET, BOT_TOKEN), DB paths, and the web<->daemon contract
// keys (GITEA_URL/TOKEN, WORK_DAEMON_WEBHOOK_*) are deliberately excluded
// — changing them by hand breaks the install.
//
// Each row mirrors the bash SETTABLE_KEYS array: KEY | SERVICE | DESCRIPTION.
// `propagate` is set for keys whose change requires updating the other
// service's .env (cross-link).
export interface SettableKeySpec {
  key: string;
  service: "web" | "daemon";
  description: string;
  // If set, when this key changes the listed cross-link key in the other
  // service's .env is also rewritten. Used for WORK_PORT / DAEMON_PORT.
  propagate?: {
    targetService: "web" | "daemon";
    targetKey: string;
    template: (value: string) => string;
  };
}

export const SETTABLE_KEYS: readonly SettableKeySpec[] = [
  { key: "WORK_PORT",             service: "web",    description: "ework-web listen port (default 3002)",
    propagate: { targetService: "daemon", targetKey: "GITEA_URL", template: (v) => `http://127.0.0.1:${v}` } },
  { key: "WORK_HOST",             service: "web",    description: "ework-web bind address (default 127.0.0.1; 0.0.0.0 for LAN)" },
  { key: "WORK_OPERATOR_LOGIN",   service: "web",    description: "login auto-promoted to admin" },
  { key: "WORK_TRANSLATE_URL",    service: "web",    description: "OpenAI-compat /v1/chat/completions endpoint for translate" },
  { key: "WORK_TRANSLATE_MODEL",  service: "web",    description: "translate model name" },
  { key: "WORK_TTS_SPEED",        service: "web",    description: "TTS playback rate (default 1.0)" },
  { key: "WORK_FILE_ROOTS",       service: "web",    description: "comma-separated file-viewer roots" },
  { key: "WORK_COMMENT_SORT",     service: "web",    description: "comment sort order: desc|asc" },
  { key: "DAEMON_PORT",           service: "daemon", description: "ework-daemon listen port (default 3101)",
    propagate: { targetService: "web", targetKey: "WORK_DAEMON_WEBHOOK_URL", template: (v) => `http://127.0.0.1:${v}` } },
  { key: "DAEMON_HOST",           service: "daemon", description: "ework-daemon bind address (default 127.0.0.1)" },
  { key: "OPENCODE_BINARY",       service: "daemon", description: "opencode binary path" },
  { key: "OPENCODE_BASE_WORKDIR", service: "daemon", description: "opencode working directory base" },
  { key: "COMPLETION_CHECK_API_KEY",  service: "daemon", description: "completion-check API key" },
  { key: "COMPLETION_CHECK_BASE_URL", service: "daemon", description: "completion-check API base URL" },
  { key: "COMPLETION_CHECK_MODEL",    service: "daemon", description: "completion-check model name" },
] as const;

// For a given key, which service(s) need to restart on change. WORK_PORT
// and DAEMON_PORT fan out to "both" because their cross-link touches the
// other service's .env.
export function serviceForKey(key: string): ServiceTarget | null {
  if (key === "WORK_PORT" || key === "DAEMON_PORT") return "both";
  for (const entry of SETTABLE_KEYS) {
    if (entry.key === key) return entry.service;
  }
  return null;
}

export function findSettableKey(key: string): SettableKeySpec | null {
  for (const entry of SETTABLE_KEYS) {
    if (entry.key === key) return entry;
  }
  return null;
}
