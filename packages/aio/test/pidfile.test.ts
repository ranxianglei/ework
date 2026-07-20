import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  startProcess,
  stopProcess,
  readPidFile,
  isProcessRunning,
  writePidFileAtomic,
  PidFileError,
} from "../src/pidfile.ts";

let tmpDir: string;

async function waitForReady(logFile: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await fs.promises.readFile(logFile, "utf8");
      if (content.includes("READY")) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Child did not write READY to ${logFile} within ${timeoutMs}ms`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-pid-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writePidFileAtomic + readPidFile", () => {
  it("writes pid and reads it back", async () => {
    const pidFile = path.join(tmpDir, "test.pid");
    await writePidFileAtomic(pidFile, 12345);
    const pid = await readPidFile(pidFile);
    expect(pid).toBe(12345);
  });

  it("returns null for missing file", async () => {
    const pid = await readPidFile(path.join(tmpDir, "missing.pid"));
    expect(pid).toBeNull();
  });

  it("returns null for malformed content", async () => {
    const pidFile = path.join(tmpDir, "bad.pid");
    await fs.promises.writeFile(pidFile, "not-a-number\n");
    const pid = await readPidFile(pidFile);
    expect(pid).toBeNull();
  });

  it("creates parent dir if missing", async () => {
    const pidFile = path.join(tmpDir, "nested", "deep", "test.pid");
    await writePidFileAtomic(pidFile, 99999);
    const pid = await readPidFile(pidFile);
    expect(pid).toBe(99999);
  });
});

describe("isProcessRunning", () => {
  it("returns true for current process", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("returns false for unused pid", () => {
    // pid 0x7fffffff is reserved/unused on linux
    expect(isProcessRunning(2147483647)).toBe(false);
  });
});

describe("startProcess + stopProcess (real subprocess)", () => {
  it("starts a sleep process, writes pidfile, can stop it", async () => {
    const logFile = path.join(tmpDir, "sleep.log");
    const pidFile = path.join(tmpDir, "sleep.pid");

    const result = await startProcess({
      cmd: "sleep",
      args: ["30"],
      logFile,
      pidFile,
    });

    expect(result.pid).toBeGreaterThan(0);
    expect(isProcessRunning(result.pid)).toBe(true);

    // PID file written
    const writtenPid = await readPidFile(pidFile);
    expect(writtenPid).toBe(result.pid);

    // Stop should kill it
    const stopResult = await stopProcess(pidFile, { graceMs: 2000 });
    expect(stopResult.pid).toBe(result.pid);
    expect(stopResult.timedOut).toBe(false);
    expect(isProcessRunning(result.pid)).toBe(false);

    // pidfile cleaned up
    expect(await readPidFile(pidFile)).toBeNull();
  });

  it("handles stale pidfile (process already dead)", async () => {
    const pidFile = path.join(tmpDir, "stale.pid");
    // Use a pid that was alive briefly — spawn sleep, kill it, leave pidfile pointing to it
    const sleepResult = await startProcess({
      cmd: "sleep",
      args: ["1"],
      logFile: path.join(tmpDir, "stale.log"),
      pidFile,
    });
    const pid = sleepResult.pid;
    // Wait for sleep to exit naturally (1 second)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(isProcessRunning(pid)).toBe(false);

    // pidfile should still exist
    expect(await readPidFile(pidFile)).toBe(pid);

    const result = await stopProcess(pidFile);
    expect(result.killed).toBe(false); // wasn't killed by us, already dead
    // stale pidfile should be cleaned up
    expect(await readPidFile(pidFile)).toBeNull();
  });

  it("throws PidFileError when pidfile missing", async () => {
    await expect(stopProcess(path.join(tmpDir, "never-existed.pid"))).rejects.toThrow(PidFileError);
  });

  it("falls back to SIGKILL after grace period", async () => {
    const logFile = path.join(tmpDir, "trap.log");
    const pidFile = path.join(tmpDir, "trap.pid");
    const externalLog = "/tmp/ework-fail-trap.log";
    fs.writeFileSync(externalLog, "");

    const childScript = `
      const fs = require("fs");
      const log = (m) => fs.appendFileSync("${externalLog}", "child: " + m + "\\n");
      log("READY");
      ["SIGTERM","SIGINT","SIGHUP","SIGUSR1","SIGUSR2","SIGPIPE"].forEach(sig => {
        process.on(sig, () => log("got " + sig));
      });
      process.on("exit", (c) => log("exit code=" + c));
      setInterval(() => {}, 1000);
    `;
    const result = await startProcess({
      cmd: process.execPath,
      args: ["-e", childScript],
      logFile,
      pidFile,
    });
    expect(isProcessRunning(result.pid)).toBe(true);

    // Wait for child to install signal handlers (writes READY to log).
    // Without this, SIGTERM can arrive before handlers are registered,
    // hitting default-terminate and making the test pass for wrong reasons.
    await waitForReady(externalLog, 1000);

    const stopResult = await stopProcess(pidFile, { graceMs: 300, sigkillAfter: true });
    expect(stopResult.timedOut).toBe(true);
    expect(stopResult.killed).toBe(true);
    // SIGKILL delivery + kernel reaping is async — give it a beat.
    await new Promise((r) => setTimeout(r, 50));
    expect(isProcessRunning(result.pid)).toBe(false);
  });

  it("respects sigkillAfter=false (only SIGTERM)", async () => {
    const logFile = path.join(tmpDir, "trap2.log");
    const pidFile = path.join(tmpDir, "trap2.pid");
    const externalLog = "/tmp/ework-fail-trap2.log";
    fs.writeFileSync(externalLog, "");

    const childScript = `
      const fs = require("fs");
      const log = (m) => fs.appendFileSync("${externalLog}", "child: " + m + "\\n");
      log("READY");
      ["SIGTERM","SIGINT","SIGHUP"].forEach(sig => {
        process.on(sig, () => log("got " + sig));
      });
      setInterval(() => {}, 1000);
    `;
    const result = await startProcess({
      cmd: process.execPath,
      args: ["-e", childScript],
      logFile,
      pidFile,
    });
    await waitForReady(externalLog, 1000);

    const stopResult = await stopProcess(pidFile, { graceMs: 300, sigkillAfter: false });
    expect(stopResult.timedOut).toBe(true);
    expect(stopResult.killed).toBe(false);
    expect(isProcessRunning(result.pid)).toBe(true);

    process.kill(result.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("appends stdout to log file", async () => {
    const logFile = path.join(tmpDir, "echo.log");
    const pidFile = path.join(tmpDir, "echo.pid");

    await startProcess({
      cmd: "sh",
      args: ["-c", 'echo "hello-from-child"; sleep 0.1'],
      logFile,
      pidFile,
    });

    // Wait for output to flush
    await new Promise((resolve) => setTimeout(resolve, 300));

    const logContent = await fs.promises.readFile(logFile, "utf8");
    expect(logContent).toContain("hello-from-child");
  });
});
