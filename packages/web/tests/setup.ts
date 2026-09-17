import { randomUUID } from "node:crypto";

// pid alone is not unique: bun recycles pids across parallel test files, so two
// files can pin the same DB and one server's boot migration hits SQLITE_BUSY in
// the other's (seen in CI as an undiagnosable healthz timeout). uuid fixes it.
process.env.WORK_DB_PATH = `/tmp/ework-test-${process.pid}-${randomUUID()}.db`;
process.env.WORK_TOKEN ??= "ci-test-token-0123456789";
process.env.WORK_COOKIE_SECRET ??= "ci-test-cookie-secret-0123";
process.env.WORK_AUTOWIRE_ACTIVE = "false";
process.env.WORK_WEBHOOK_MAX_CONCURRENT = "3";
