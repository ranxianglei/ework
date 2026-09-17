// Per-PID temp DB so tests can NEVER touch the engine/production database,
// regardless of what WORK_DB_PATH/DAEMON_DB_PATH the caller inherited.
// os.tmpdir() honors $TMPDIR (required on hosts where /tmp is read-only).
import { tmpdir } from "os";

process.env.WORK_DB_PATH = `${tmpdir()}/ework-daemon-test-${process.pid}.db`;
// The host may run tests inside a live daemon environment; the production
// wake whitelist would silently gate test authors out of dispatch.
delete process.env.WORK_WAKE_LOGINS;
