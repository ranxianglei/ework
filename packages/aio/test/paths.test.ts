import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { resolvePaths } from "../src/paths.ts";

describe("resolvePaths: data dir resolution", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("uses XDG_DATA_HOME when set", () => {
    process.env.XDG_DATA_HOME = "/custom/data";
    const p = resolvePaths({ scope: "user", useSystemd: false });
    expect(p.dataDir).toBe(path.join("/custom/data", "ework-aio"));
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME unset", () => {
    const p = resolvePaths({ scope: "user", useSystemd: false, dataDir: undefined });
    // Don't assert on exact home path (CI vs local), just the suffix.
    expect(p.dataDir.endsWith(path.join(".local", "share", "ework-aio"))).toBe(true);
  });

  it("uses --data-dir when provided (overrides XDG_DATA_HOME)", () => {
    process.env.XDG_DATA_HOME = "/custom/data";
    const p = resolvePaths({ scope: "user", useSystemd: false, dataDir: "/explicit/dir" });
    expect(p.dataDir).toBe("/explicit/dir");
  });
});

describe("resolvePaths: config home precedence (testability)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // opts.configHome MUST take precedence over XDG_CONFIG_HOME. The previous
  // precedence (env || opts || default) meant tests couldn't override a
  // developer's real XDG_CONFIG_HOME, causing test runs to leak into
  // ~/.config/opencode/opencode.json on machines with XDG_CONFIG_HOME set.
  it("opts.configHome wins over XDG_CONFIG_HOME (testability)", () => {
    process.env.XDG_CONFIG_HOME = "/user/config";
    const p = resolvePaths({
      scope: "user",
      useSystemd: false,
      configHome: "/test/config",
    });
    // systemd unit dir uses xdgConfigHome; opencodeConfigFile uses it too.
    expect(p.opencodeConfigFile).toBe(path.join("/test/config", "opencode", "opencode.json"));
  });

  it("uses XDG_CONFIG_HOME when opts.configHome not provided", () => {
    process.env.XDG_CONFIG_HOME = "/user/config";
    const p = resolvePaths({ scope: "user", useSystemd: false });
    expect(p.opencodeConfigFile).toBe(path.join("/user/config", "opencode", "opencode.json"));
  });

  it("falls back to ~/.config when neither opts.configHome nor XDG_CONFIG_HOME set", () => {
    delete process.env.XDG_CONFIG_HOME;
    const p = resolvePaths({ scope: "user", useSystemd: false });
    expect(p.opencodeConfigFile.endsWith(path.join(".config", "opencode", "opencode.json"))).toBe(true);
  });

  it("user-scope systemd unit dir respects opts.configHome override", () => {
    process.env.XDG_CONFIG_HOME = "/user/config";
    const p = resolvePaths({
      scope: "user",
      useSystemd: true,
      configHome: "/test/config",
    });
    expect(p.webUnitFile).toBe(path.join("/test/config", "systemd", "user", "ework-web.service"));
  });
});

describe("resolvePaths: systemd unit file location", () => {
  it("returns null unit files when useSystemd=false", () => {
    const p = resolvePaths({ scope: "user", useSystemd: false });
    expect(p.webUnitFile).toBeNull();
    expect(p.daemonUnitFile).toBeNull();
  });

  it("user scope: unit dir under XDG_CONFIG_HOME/systemd/user", () => {
    const p = resolvePaths({
      scope: "user",
      useSystemd: true,
      configHome: "/test/config",
    });
    expect(p.webUnitFile).toBe(path.join("/test/config", "systemd", "user", "ework-web.service"));
  });

  it("system scope: unit dir is /etc/systemd/system (fixed path)", () => {
    const p = resolvePaths({ scope: "system", useSystemd: true });
    expect(p.webUnitFile).toBe("/etc/systemd/system/ework-web.service");
    expect(p.daemonUnitFile).toBe("/etc/systemd/system/ework-daemon.service");
  });
});
