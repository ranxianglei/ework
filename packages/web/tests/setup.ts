process.env.WORK_DB_PATH = `/tmp/ework-test-${process.pid}.db`;
process.env.WORK_TOKEN ??= "ci-test-token-0123456789";
process.env.WORK_COOKIE_SECRET ??= "ci-test-cookie-secret-0123";
process.env.WORK_AUTOWIRE_ACTIVE = "false";
process.env.WORK_WEBHOOK_MAX_CONCURRENT = "3";
