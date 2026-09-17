// Bun [test] preload (see bunfig.toml). Runs before any test file is loaded,
// which matters because src/db resolves its DB path at module-import time.
import { isolateTestDbEnv } from "./env-isolation";

isolateTestDbEnv();

// The host may run tests inside a live daemon environment; the production
// wake whitelist would silently gate test authors out of dispatch.
delete process.env.WORK_WAKE_LOGINS;
