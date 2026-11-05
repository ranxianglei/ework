import { randomUUID } from "node:crypto";
import { tmpdir } from "os";
import { join } from "path";

// Defense-in-depth layer for ranxianglei/ework#7. This module MUST run before
// anything imports src/db: db.ts resolves the SQLite file path at module load
// from WORK_DB_PATH || DAEMON_DB_PATH. The daemon spawns agents with its full
// environment, and an agent-run `bun test` once opened the PRODUCTION engine
// DB through inherited DAEMON_DB_PATH and wiped it (incident bc#853). Pinning
// WORK_DB_PATH here and deleting the fallback keys makes every daemon test
// create and use a throwaway DB under the system tmpdir, whatever env the
// invoking shell carries.

export const ISOLATED_DB_ENV_KEYS = [
  "DAEMON_DB_PATH",
  "WORK_DB_PATH",
  "OPENCODE_DB_PATH",
  "DAEMON_ENV",
] as const;

let pinnedPath = "";

/** Scrub inherited DB-pointer vars and pin WORK_DB_PATH to a unique tmp file. */
export function isolateTestDbEnv(): string {
  for (const key of ISOLATED_DB_ENV_KEYS) delete process.env[key];
  // An inherited table prefix would redirect writes into prefixed tables of
  // whatever database the daemon points at — same leak class.
  delete process.env.WORK_DB_PREFIX;
  // Tests must never dial into a MySQL server from inherited production env.
  process.env.WORK_DB_DRIVER = "sqlite";
  // pid alone is not unique across a bun test run: pids are recycled between
  // parallel files, so a later file could reopen the earlier file's stale DB
  // and race its migrations (observed: no such column during the uid rebuild).
  pinnedPath = join(tmpdir(), `ework-daemon-test-${process.pid}-${randomUUID()}.db`);
  process.env.WORK_DB_PATH = pinnedPath;
  return pinnedPath;
}

/** Path isolateTestDbEnv() pinned (empty string if it has not run yet). */
export function isolatedDbPath(): string {
  return pinnedPath;
}

/** Throw if the isolation side effects are missing or were clobbered. */
export function assertIsolatedDbEnv(): void {
  const expected = isolatedDbPath();
  if (!expected) {
    throw new Error("isolateTestDbEnv() was never called — is tests/setup.ts wired as a bun test preload?");
  }
  if (process.env.WORK_DB_PATH !== expected) {
    throw new Error(`WORK_DB_PATH changed after isolation: ${process.env.WORK_DB_PATH} != ${expected}`);
  }
  for (const key of ISOLATED_DB_ENV_KEYS) {
    if (key === "WORK_DB_PATH") continue;
    if (process.env[key] !== undefined) {
      throw new Error(`leaked test-env var ${key}=${process.env[key]}`);
    }
  }
}
