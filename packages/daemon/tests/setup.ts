// Bun [test] preload (see bunfig.toml). Runs before any test file is loaded,
// which matters because src/db resolves its DB path at module-import time.
import { isolateTestDbEnv } from "./env-isolation";

isolateTestDbEnv();
