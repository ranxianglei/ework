import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { purgeStaleNodeModules } from "../src/workdir-gc";

const ROOT = join(tmpdir(), `ework-gc-test-${Date.now()}`);
const DAY = 24 * 60 * 60 * 1000;

function mkWorkdir(issue: string): string {
  const repo = join(ROOT, "acme--proj", issue, "proj");
  const nm = join(repo, "node_modules");
  mkdirSync(join(nm, "left-pad"), { recursive: true });
  writeFileSync(join(nm, "left-pad", "package.json"), "{}");
  return nm;
}

function age(path: string, days: number) {
  const t = new Date(Date.now() - days * DAY);
  const { utimesSync } = require("node:fs");
  utimesSync(path, t, t);
}

describe("workdir node_modules GC", () => {
  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true });
  });
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("purges stale idle dirs, keeps fresh and busy ones", async () => {
    const staleIdle = mkWorkdir("1");
    const freshIdle = mkWorkdir("2");
    const staleBusy = mkWorkdir("3");
    age(staleIdle, 9);
    age(freshIdle, 1);
    age(staleBusy, 9);

    const busy = new Set([join(staleBusy, "..")]);
    const now = Date.now();
    const removed = await purgeStaleNodeModules(ROOT, 7 * DAY, busy, now);

    expect(removed).toBe(1);
    expect(existsSync(staleIdle)).toBe(false);
    expect(existsSync(freshIdle)).toBe(true);
    expect(existsSync(staleBusy)).toBe(true);
  });

  test("ttl 0 keeps everything (opt-out)", async () => {
    const stale = mkWorkdir("4");
    age(stale, 30);
    const removed = await purgeStaleNodeModules(ROOT, 0, new Set());
    expect(removed).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });
});
