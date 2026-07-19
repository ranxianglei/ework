import { statSync } from "fs";
import { join } from "path";

const STATIC = join(__dirname, "static");
let m = 0;
for (const f of ["app.js", "session.js", "file.js", "tts.js", "highlight.css"]) {
  try {
    const s = statSync(join(STATIC, f));
    if (s.mtimeMs > m) m = s.mtimeMs;
  } catch (e) {
    /* file missing at boot — fall through to Date.now() */
  }
}

// Cache-bust query for /static/*.js — changes on every deploy (newest mtime),
// forcing browsers to fetch fresh instead of serving a stale heuristic-cached copy.
export const BUILD_ID = String(m || Date.now());
