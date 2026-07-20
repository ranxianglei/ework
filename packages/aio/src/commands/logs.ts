// `ework-aio logs [web|daemon]` — tail -f the PID-file log file.
//
// Pure-TS implementation (no `tail -f` shell-out — the constraint is JS
// handles 99% of cases, only bun/npm/opencode/sudo/systemctl are
// whitelisted). Uses fs.watchFile to poll for size changes; appends new
// bytes to stdout. Polling is portable across Linux/macOS/WSL without
// inotify quirks.

import fs from "node:fs";
import { Logger, InstallError } from "../log.ts";
import { resolvePaths } from "../paths.ts";
import type { GlobalOptions } from "../types.ts";

export async function runLogs(
  opts: GlobalOptions,
  logger: Logger,
  svc: "web" | "daemon",
): Promise<void> {
  const paths = resolvePaths({ dataDir: opts.dataDir, scope: opts.scope, useSystemd: false });
  const logFile = svc === "web" ? paths.webLogFile : paths.daemonLogFile;

  if (!fs.existsSync(logFile)) {
    throw new InstallError(
      `log file not found at ${logFile}. Start the service first: ework-aio start ${svc}`,
    );
  }

  logger.log(`tailing ${logFile} (Ctrl+C to stop)`);

  const fd = fs.openSync(logFile, "r");
  let size = fs.fstatSync(fd).size;

  // Print the last 200 lines on attach.
  const headBytes = Math.min(size, 8192);
  const headBuf = Buffer.alloc(headBytes);
  fs.readSync(fd, headBuf, 0, headBytes, size - headBytes);
  const headText = headBuf.toString("utf8");
  const headLines = headText.split("\n");
  const recent = headLines.slice(Math.max(0, headLines.length - 201)).join("\n");
  process.stdout.write(recent);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    fs.unwatchFile(logFile);
    fs.closeSync(fd);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Poll every 500ms — fs.watchFile default is 5007ms which feels laggy.
  fs.watchFile(logFile, { interval: 500 }, (curr) => {
    if (curr.size > size) {
      const len = curr.size - size;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size);
      process.stdout.write(buf.toString("utf8"));
      size = curr.size;
    } else if (curr.size < size) {
      // File was truncated (log rotation). Reset to end.
      size = curr.size;
    }
  });

  // Hold the process open until signal.
  await new Promise<void>(() => {
    // never resolves; signal handler exits
  });
}
