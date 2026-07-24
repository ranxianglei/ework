import { test, expect, describe, afterEach } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveBundledBin } from "../src/preflight.ts";

// B-1: ework-web / ework-daemon are declared dependencies of ework-aio, so
// they are bundled under the package's own node_modules. resolveBundledBin
// locates them there so `ework-aio install` does not depend on npm having
// created a global bin symlink (which it fails to recreate after
// uninstall+reinstall, previously making install wrongly demand the user
// "install ework-web first").
describe("resolveBundledBin (B-1)", () => {
  const savedRoot = process.env.AIO_PACKAGE_ROOT;
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.AIO_PACKAGE_ROOT;
    else process.env.AIO_PACKAGE_ROOT = savedRoot;
  });

  test("finds bundled ework-web / ework-daemon from the real package node_modules", () => {
    delete process.env.AIO_PACKAGE_ROOT;
    const web = resolveBundledBin("ework-web", "bin/ework-web.js");
    expect(web).not.toBeNull();
    expect(web).toContain("node_modules");
    expect(fs.existsSync(web!)).toBe(true);

    const server = resolveBundledBin("ework-daemon", "bin/ework-daemon-server.js");
    expect(server).not.toBeNull();
    expect(fs.existsSync(server!)).toBe(true);
  });

  test("returns null when AIO_PACKAGE_ROOT points at an empty dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aio-preflight-"));
    try {
      process.env.AIO_PACKAGE_ROOT = tmp;
      expect(resolveBundledBin("ework-web", "bin/ework-web.js")).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
