import { expect, test, describe } from "bun:test";
import { buildEnvBlock, type DeployTarget } from "../src/daemon-deploy";

const baseTarget: DeployTarget = {
  sshHost: "192.168.10.96",
  sshUser: "dog",
  sshPort: 1194,
  mysqlHost: "192.168.10.157",
};

describe("buildEnvBlock — GITEA_URL localhost leak (Bug 3 regression)", () => {
  test("rewrites 127.0.0.1 in GITEA_URL to detected LAN IP", () => {
    const env = new Map<string, string>([["GITEA_URL", "http://127.0.0.1:3002"]]);
    const block = buildEnvBlock(env, baseTarget);
    expect(block).not.toContain("127.0.0.1:3002");
    const giteaLine = block.split("\n").find((l) => l.startsWith("GITEA_URL="));
    expect(giteaLine).toBeDefined();
    expect(giteaLine!.startsWith("GITEA_URL=http://")).toBe(true);
  });

  test("rewrites localhost in GITEA_URL to detected LAN IP", () => {
    const env = new Map<string, string>([["GITEA_URL", "http://localhost:3002"]]);
    const block = buildEnvBlock(env, baseTarget);
    expect(block).not.toContain("localhost:3002");
  });

  test("preserves GITEA_URL that already uses a non-loopback IP", () => {
    const env = new Map<string, string>([["GITEA_URL", "http://192.168.10.157:3002"]]);
    const block = buildEnvBlock(env, baseTarget);
    expect(block).toContain("GITEA_URL=http://192.168.10.157:3002");
  });
});

describe("buildEnvBlock — MySQL host + port config", () => {
  test("strips :port suffix from mysqlHost", () => {
    const env = new Map<string, string>();
    const block = buildEnvBlock(env, { ...baseTarget, mysqlHost: "192.168.10.157:3306" });
    expect(block).toContain("WORK_DB_HOST=192.168.10.157");
    expect(block).not.toContain("WORK_DB_HOST=192.168.10.157:3306");
  });

  test("sets DAEMON_HOST to 0.0.0.0 for LAN accessibility", () => {
    const env = new Map<string, string>();
    const block = buildEnvBlock(env, baseTarget);
    expect(block).toContain("DAEMON_HOST=0.0.0.0");
  });

  test("sets DAEMON_PORT from target", () => {
    const env = new Map<string, string>();
    const block = buildEnvBlock(env, { ...baseTarget, daemonPort: 3102 });
    expect(block).toContain("DAEMON_PORT=3102");
  });
});

describe("buildEnvBlock — OPENCODE_BINARY excluded", () => {
  test("does not forward OPENCODE_BINARY (remote uses PATH)", () => {
    const env = new Map<string, string>([["OPENCODE_BINARY", "/home/dog/.local/bin/opencode"]]);
    const block = buildEnvBlock(env, baseTarget);
    expect(block).not.toContain("OPENCODE_BINARY");
  });
});

describe("deploy grep regex — pretty-printed JSON (Bug 2 regression)", () => {
  test("regex matches pretty-printed daemon status (2-space indent)", () => {
    const statusJson = JSON.stringify({ driver: "mysql", issues: 1 }, null, 2);
    expect(statusJson).toMatch(/"driver" *: *"mysql"/);
  });

  test("regex matches compact JSON (no spaces)", () => {
    const statusJson = JSON.stringify({ driver: "mysql" });
    expect(statusJson).toMatch(/"driver" *: *"mysql"/);
  });

  test("regex matches with extra whitespace", () => {
    const statusJson = '{\n  "driver"   :   "mysql"\n}';
    expect(statusJson).toMatch(/"driver" *: *"mysql"/);
  });

  test("regex does NOT match sqlite", () => {
    const statusJson = JSON.stringify({ driver: "sqlite" }, null, 2);
    expect(statusJson).not.toMatch(/"driver" *: *"mysql"/);
  });
});
