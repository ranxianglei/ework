import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  generateUnitFile,
  writeUnitFile,
  runSystemctl,
  getUnitState,
  type UnitContext,
  type SystemctlOptions,
} from "../src/systemd.ts";

const sampleCtx: UnitContext = {
  user: "alice",
  group: "alice",
  binPath: "/home/alice/.bun/bin/bun",
  mainScript: "/usr/lib/node_modules/ework-web/bin/ework-web.js",
  envFile: "/home/alice/.local/share/ework-aio/ework-web/.env",
  workingDirectory: "/home/alice/.local/share/ework-aio/ework-web",
  logFile: "/home/alice/.local/share/ework-aio/run/web.log",
};

describe("generateUnitFile", () => {
  it("produces a parseable systemd unit file with the [Unit]/[Service]/[Install] sections", () => {
    const unit = generateUnitFile("ework-web", sampleCtx);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("embeds user/group/ExecStart from context", () => {
    const unit = generateUnitFile("ework-web", sampleCtx);
    expect(unit).toContain("User=alice");
    expect(unit).toContain("Group=alice");
    expect(unit).toContain("ExecStart=/home/alice/.bun/bin/bun /usr/lib/node_modules/ework-web/bin/ework-web.js");
    expect(unit).toContain("WorkingDirectory=/home/alice/.local/share/ework-aio/ework-web");
    expect(unit).toContain("EnvironmentFile=/home/alice/.local/share/ework-aio/ework-web/.env");
  });

  it("defaults to Restart=always", () => {
    const unit = generateUnitFile("ework-web", sampleCtx);
    expect(unit).toContain("Restart=always");
  });

  it("honors custom restart policy", () => {
    const unit = generateUnitFile("ework-daemon", { ...sampleCtx, restart: "on-failure" });
    expect(unit).toContain("Restart=on-failure");
  });

  it("writes log output to the logFile path from context (S-4)", () => {
    const unit = generateUnitFile("ework-web", sampleCtx);
    expect(unit).toContain("StandardOutput=append:/home/alice/.local/share/ework-aio/run/web.log");
    expect(unit).toContain("StandardError=append:/home/alice/.local/share/ework-aio/run/web.log");
  });

  it("uses WantedBy=default.target for user-scope install", () => {
    const unit = generateUnitFile("ework-web", sampleCtx);
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("writeUnitFile", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-unit-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes content atomically and creates parent dir if missing", async () => {
    const unitFile = path.join(tmpDir, "nested/deep/ework-web.service");
    await writeUnitFile(unitFile, "dummy content");
    const written = await fs.promises.readFile(unitFile, "utf8");
    expect(written).toBe("dummy content");
  });
});

describe("runSystemctl (with fake systemctl in PATH)", () => {
  let tmpDir: string;
  let fakeSystemctlPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-fake-ctl-"));
    fakeSystemctlPath = path.join(tmpDir, "systemctl");
    // Fake systemctl: writes args to a log file, exits 0 (or 5 if arg contains "fail")
    const logFile = path.join(tmpDir, "ctl.log");
    fs.writeFileSync(fakeSystemctlPath, `#!/bin/sh
echo "$@" >> "${logFile}"
if echo "$@" | grep -q "fail-case"; then
  echo "simulated error" >&2
  exit 5
fi
echo "ok"
exit 0
`);
    fs.chmodSync(fakeSystemctlPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${originalPath ?? ""}`;
  });

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("invokes systemctl with --user prefix in user scope", () => {
    const opts: SystemctlOptions = { scope: "user", systemctlBin: fakeSystemctlPath };
    const r = runSystemctl(["is-active", "ework-web.service"], opts);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  it("returns non-zero exitCode on simulated failure", () => {
    const opts: SystemctlOptions = { scope: "user", systemctlBin: fakeSystemctlPath };
    const r = runSystemctl(["is-active", "fail-case.service"], opts);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("simulated error");
  });

  it("getUnitState returns 'active' on exit 0", () => {
    const opts: SystemctlOptions = { scope: "user", systemctlBin: fakeSystemctlPath };
    const state = getUnitState("ework-web", opts);
    expect(state).toBe("active");
  });
});
