import { tmpdir } from "os";
import { unlinkSync } from "fs";

// Per-PID temp DB under os.tmpdir() (honors $TMPDIR; /tmp is read-only on
// some hosts), so tests never touch the host database regardless of any
// inherited WORK_DB_PATH. Mirrors packages/daemon/tests/setup.ts.
process.env.WORK_DB_PATH = `${tmpdir()}/ework-test-${process.pid}.db`;
// PIDs recycle: a reused PID inherits a stale DB whose FK DDL can still
// reference users_old from a crashed surrogate-id migration era (seen
// 2026-10-28: "no such table main.users_old" on every insert). Start clean.
for (const suffix of ["", "-wal", "-shm"]) {
  try { unlinkSync(`${process.env.WORK_DB_PATH}${suffix}`); } catch {}
}
process.env.WORK_TOKEN ??= "ci-test-token-0123456789";
process.env.WORK_COOKIE_SECRET ??= "ci-test-cookie-secret-0123";
process.env.WORK_AUTOWIRE_ACTIVE = "false";
process.env.WORK_WEBHOOK_MAX_CONCURRENT = "3";
