// Spawned by db-isolation.test.ts (not a test file itself). Simulates the
// incident vector: an agent-spawned test process that inherited the daemon's
// DAEMON_DB_PATH, then verifies the isolation layer redirects it before
// src/db resolves the path.
const fakeProd = process.env.FAKE_PROD_DB ?? "/nonexistent/prod.db";
process.env.DAEMON_DB_PATH = fakeProd;
delete process.env.WORK_DB_PATH;
delete process.env.OPENCODE_DB_PATH;
delete process.env.DAEMON_ENV;

const { isolateTestDbEnv } = await import("./env-isolation.ts");
isolateTestDbEnv();

const { initDB, RESOLVED_DB_PATH } = await import("../src/db.ts");
await initDB();
if (!RESOLVED_DB_PATH) throw new Error("no resolved sqlite path in child");
console.log(JSON.stringify({ resolved: RESOLVED_DB_PATH, fakeProd }));
