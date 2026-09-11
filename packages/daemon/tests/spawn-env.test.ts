import { describe, test, expect } from "bun:test";
import { spawnEnvFor } from "../src/opencode";

describe("spawnEnvFor — per-issue npm isolation", () => {
  const workdir = "/srv/work/dog--widget/42";

  test("npm -g installs redirect to the issue workdir", () => {
    const env = spawnEnvFor({ PATH: "/usr/bin:/bin", HOME: "/root" }, { EWORK_ISSUE: "42" }, workdir);
    expect(env.NPM_CONFIG_PREFIX).toBe(`${workdir}/.npm-global`);
    expect(env.PATH).toBe(`${workdir}/.npm-global/bin:/usr/bin:/bin`);
  });

  test("hook env survives, base env passthrough, existing NPM_CONFIG_PREFIX overridden", () => {
    const env = spawnEnvFor(
      { PATH: "/usr/bin", HOME: "/root", NPM_CONFIG_PREFIX: "/usr" },
      { EWORK_SENDER: "alice" },
      workdir,
    );
    expect(env.NPM_CONFIG_PREFIX).toBe(`${workdir}/.npm-global`);
    expect(env.EWORK_SENDER).toBe("alice");
    expect(env.HOME).toBe("/root");
  });

  test("missing base PATH still yields a usable PATH", () => {
    const env = spawnEnvFor({}, {}, workdir);
    expect(env.PATH).toBe(`${workdir}/.npm-global/bin:`);
  });
});
