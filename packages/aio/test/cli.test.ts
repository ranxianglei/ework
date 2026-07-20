// Unit tests for src/cli.ts parseArgs. Pure-function cases — no process.argv
// mutation, no command execution. main() dispatch is exercised by the
// integration test in install.test.ts (with mocked commands).

import { test, expect, describe } from "bun:test";
import { parseArgs } from "../src/cli.ts";

describe("parseArgs: subcommand detection", () => {
  test("empty argv → default subcommand 'install'", () => {
    const r = parseArgs([]);
    expect(r.subcommand).toBe("install");
    expect(r.opts.useSystemd).toBe(false);
    expect(r.opts.scope).toBe("user");
  });

  test("'install' positional", () => {
    expect(parseArgs(["install"]).subcommand).toBe("install");
  });

  test("'install systemd' → useSystemd=true", () => {
    const r = parseArgs(["install", "systemd"]);
    expect(r.opts.useSystemd).toBe(true);
  });

  test("'systemd' without install (bare) → still sets useSystemd", () => {
    // Bare `systemd` is a global flag; install is the default subcommand.
    const r = parseArgs(["systemd"]);
    expect(r.opts.useSystemd).toBe(true);
    expect(r.subcommand).toBe("install");
  });

  test("'uninstall' / 'status' / 'logs' / 'env'", () => {
    expect(parseArgs(["uninstall"]).subcommand).toBe("uninstall");
    expect(parseArgs(["status"]).subcommand).toBe("status");
    expect(parseArgs(["logs"]).subcommand).toBe("logs");
    expect(parseArgs(["env"]).subcommand).toBe("env");
  });

  test("'ps' is preserved as a subcommand alias", () => {
    expect(parseArgs(["ps"]).subcommand).toBe("ps");
  });
});

describe("parseArgs: global flags", () => {
  test("--user / --system", () => {
    expect(parseArgs(["--user"]).opts.scope).toBe("user");
    expect(parseArgs(["--system"]).opts.scope).toBe("system");
  });

  test("--yes / -y", () => {
    expect(parseArgs(["--yes"]).opts.assumeYes).toBe(true);
    expect(parseArgs(["-y"]).opts.assumeYes).toBe(true);
    expect(parseArgs(["install"]).opts.assumeYes).toBe(false);
  });

  test("--allow-root", () => {
    expect(parseArgs(["--allow-root"]).opts.allowRoot).toBe(true);
  });

  test("--no-start", () => {
    const r = parseArgs(["--no-start"]);
    expect(r.opts.noStart).toBe(true);
  });

  test("--no-restart", () => {
    expect(parseArgs(["--no-restart"]).opts.noRestart).toBe(true);
  });

  test("--data-dir <path>", () => {
    expect(parseArgs(["--data-dir", "/tmp/xa"]).opts.dataDir).toBe("/tmp/xa");
  });

  test("--data-dir without value → throws", () => {
    expect(() => parseArgs(["--data-dir"])).toThrow(/--data-dir requires a value/);
  });

  test("--port <n> parses as number", () => {
    const r = parseArgs(["--port", "8080"]);
    expect(r.opts.workPort).toBe(8080);
  });

  test("--port out of range → throws", () => {
    expect(() => parseArgs(["--port", "99999"])).toThrow(/invalid value/);
    expect(() => parseArgs(["--port", "0"])).toThrow(/invalid value/);
    expect(() => parseArgs(["--port", "-5"])).toThrow(/invalid value/);
  });

  test("--port non-numeric → throws", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(/invalid value/);
  });

  test("--daemon-port <n>", () => {
    expect(parseArgs(["--daemon-port", "4000"]).opts.daemonPort).toBe(4000);
  });

  test("--bot-name <login>", () => {
    expect(parseArgs(["--bot-name", "mybot"]).opts.botName).toBe("mybot");
  });

  test("--as-user <login>", () => {
    expect(parseArgs(["--as-user", "alice"]).opts.asUser).toBe("alice");
  });

  test("unknown flag → throws", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
  });
});

describe("parseArgs: config subcommand", () => {
  test("config list (default)", () => {
    const r = parseArgs(["config"]);
    expect(r.subcommand).toBe("config");
    expect(r.configArgs.subcommand).toBe("list");
  });

  test("config get <KEY>", () => {
    const r = parseArgs(["config", "get", "WORK_PORT"]);
    expect(r.configArgs.subcommand).toBe("get");
    expect(r.configArgs.key).toBe("WORK_PORT");
  });

  test("config set <KEY> <VALUE>", () => {
    const r = parseArgs(["config", "set", "WORK_PORT", "8080"]);
    expect(r.configArgs.subcommand).toBe("set");
    expect(r.configArgs.key).toBe("WORK_PORT");
    expect(r.configArgs.value).toBe("8080");
  });

  test("config set with --no-restart", () => {
    const r = parseArgs(["config", "set", "WORK_PORT", "8080", "--no-restart"]);
    expect(r.configArgs.subcommand).toBe("set");
    expect(r.configArgs.key).toBe("WORK_PORT");
    expect(r.configArgs.value).toBe("8080");
    expect(r.opts.noRestart).toBe(true);
  });

  test("config restart <target>", () => {
    expect(parseArgs(["config", "restart", "web"]).configArgs.target).toBe("web");
    expect(parseArgs(["config", "restart", "daemon"]).configArgs.target).toBe("daemon");
    expect(parseArgs(["config", "restart", "both"]).configArgs.target).toBe("both");
  });

  test("config restart without target → undefined (defaults to both)", () => {
    const r = parseArgs(["config", "restart"]);
    expect(r.configArgs.target).toBeUndefined();
  });

  test("config restart with invalid target → target undefined", () => {
    // Invalid target is silently dropped here; lifecycle parses at call time.
    const r = parseArgs(["config", "restart", "bogus"]);
    expect(r.configArgs.target).toBeUndefined();
  });

  test("config unknown subcommand → help", () => {
    const r = parseArgs(["config", "bogus"]);
    expect(r.configArgs.subcommand).toBe("help");
  });

  test("config set with --flag-like VALUE → rejected as unknown option", () => {
    // `config set WORK_PORT --foo` — --foo is not a known global flag, so
    // parser rejects. (KEY is consumed; VALUE slot stays undefined because
    // --foo starts with '-'.)
    expect(() => parseArgs(["config", "set", "WORK_PORT", "--foo"])).toThrow(/Unknown option: --foo/);
  });

  test("config global flags still apply (--data-dir)", () => {
    const r = parseArgs(["config", "list", "--data-dir", "/tmp/x"]);
    expect(r.opts.dataDir).toBe("/tmp/x");
    expect(r.configArgs.subcommand).toBe("list");
  });
});

describe("parseArgs: positional collection", () => {
  test("service target positionals", () => {
    expect(parseArgs(["start", "web"]).positionals).toEqual(["start", "web"]);
    expect(parseArgs(["start", "daemon"]).positionals).toEqual(["start", "daemon"]);
    expect(parseArgs(["start", "both"]).positionals).toEqual(["start", "both"]);
    expect(parseArgs(["stop"]).positionals).toEqual(["stop"]);
  });

  test("logs target positional", () => {
    expect(parseArgs(["logs", "daemon"]).positionals).toEqual(["logs", "daemon"]);
    expect(parseArgs(["logs", "web"]).positionals).toEqual(["logs", "web"]);
  });

  test("flags can appear after positional", () => {
    const r = parseArgs(["start", "web", "--data-dir", "/tmp/x"]);
    expect(r.positionals).toEqual(["start", "web"]);
    expect(r.opts.dataDir).toBe("/tmp/x");
  });
});

describe("parseArgs: combination cases", () => {
  test("install systemd --port 8080 --yes", () => {
    const r = parseArgs(["install", "systemd", "--port", "8080", "--yes"]);
    expect(r.opts.useSystemd).toBe(true);
    expect(r.opts.workPort).toBe(8080);
    expect(r.opts.assumeYes).toBe(true);
  });

  test("--system install (flag before positional)", () => {
    const r = parseArgs(["--system", "install"]);
    expect(r.opts.scope).toBe("system");
    expect(r.subcommand).toBe("install");
  });
});
