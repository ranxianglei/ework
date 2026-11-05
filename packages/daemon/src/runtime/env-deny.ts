/**
 * Environment variables that must NEVER reach a spawned agent subprocess,
 * no matter what the caller passes in RuntimeSpawnOpts.env.
 *
 * Two classes:
 *  - OpenCode process-identity vars: a child must not impersonate its parent
 *    runtime (would break session/output introspection).
 *  - Daemon engine DB pointers + mode selector: if an agent-spawned process
 *    (including a test harness it runs) inherits these, it will open — and can
 *    wipe — the PRODUCTION engine database. This exact leak emptied the live
 *    daemon DB via `bun test` in a workdir (ranxianglei/ework#7, incident
 *    bc#853). Stripping them here is the root-cause fix; tests/setup.ts is
 *    defense in depth.
 */
export const ENV_DENY_ALWAYS = [
  "OPENCODE",
  "OPENCODE_PID",
  "OPENCODE_RUN_ID",
  "OPENCODE_PROCESS_ROLE",
  "DAEMON_DB_PATH",
  "WORK_DB_PATH",
  "OPENCODE_DB_PATH",
  "DAEMON_ENV",
] as const;

/**
 * Return a copy of `env` with all always-denied keys removed, plus any
 * per-deployment `extraDeny` keys. Never mutates the input.
 */
export function stripDeniedEnv(
  env: Record<string, string | undefined>,
  extraDeny: readonly string[] = [],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of ENV_DENY_ALWAYS) delete out[key];
  for (const key of extraDeny) delete out[key];
  return out;
}
