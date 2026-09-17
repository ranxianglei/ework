import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { freeSpaceMb, purgeStaleNodeModules, purgeStaleWorkdirs, shouldBlockSpawn } from "../src/workdir-gc";

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

// Layout: <ROOT>/<owner>--<repo>/<issueId>/<sessionName>/... (default template).
// Separate repo dir from the node_modules describe above — both suites share
// ROOT and would otherwise cross-contaminate via stale sibling issue dirs.
function mkIssueWorkdir(issue: string): string {
  const issueDir = join(ROOT, "acme--fullgc", issue);
  const session = join(issueDir, "work");
  mkdirSync(join(session, ".git"), { recursive: true });
  writeFileSync(join(session, "package.json"), "{}");
  return issueDir;
}

function ageTree(path: string, days: number) {
  // effectiveMtimeMs takes max over dir + immediate children, so age both levels
  const t = new Date(Date.now() - days * DAY);
  const { utimesSync, readdirSync } = require("node:fs");
  utimesSync(path, t, t);
  for (const e of readdirSync(path)) utimesSync(join(path, e), t, t);
}

describe("full issue-workdir GC (purgeStaleWorkdirs)", () => {
  // Each test asserts an exact purge count, so no stale issue dir from a
  // previous test may survive into the next (protected dirs are kept on disk).
  afterEach(() => {
    rmSync(join(ROOT, "acme--fullgc"), { recursive: true, force: true });
  });

  test("deletes expired non-running workdirs", async () => {
    const stale = mkIssueWorkdir("101");
    ageTree(stale, 9);
    const removed = await purgeStaleWorkdirs(ROOT, 7 * DAY, [], Date.now());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(stale)).toBe(false);
  });

  test("keeps workdir of a running session even when expired", async () => {
    const running = mkIssueWorkdir("201");
    ageTree(running, 9);
    const sessionCwd = join(running, "work");
    const removed = await purgeStaleWorkdirs(ROOT, 7 * DAY, [sessionCwd], Date.now());
    expect(removed).toBe(0);
    expect(existsSync(running)).toBe(true);
  });

  test("keeps fresh idle workdirs and honors ttl=0 opt-out", async () => {
    const fresh = mkIssueWorkdir("301");
    expect(await purgeStaleWorkdirs(ROOT, 7 * DAY, [], Date.now())).toBe(0);
    expect(existsSync(fresh)).toBe(true);

    ageTree(fresh, 30);
    expect(await purgeStaleWorkdirs(ROOT, 0, [], Date.now())).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  test("protects whole repo level when a live process cwd sits above issue dirs", async () => {
    const protectedRepo = mkIssueWorkdir("401");
    ageTree(protectedRepo, 9);
    const repoLevel = dirname(protectedRepo);
    const removed = await purgeStaleWorkdirs(ROOT, 7 * DAY, [repoLevel], Date.now());
    expect(removed).toBe(0);
    expect(existsSync(protectedRepo)).toBe(true);
  });
});

describe("spawn disk watermark helpers", () => {
  test("freeSpaceMb reports free MB on a real path", () => {
    const mb = freeSpaceMb(tmpdir());
    expect(mb).not.toBeNull();
    expect(mb!).toBeGreaterThan(0);
  });

  test("shouldBlockSpawn decision matrix", () => {
    expect(shouldBlockSpawn(null, 1024)).toBe(false); // statfs unavailable → never block
    expect(shouldBlockSpawn(500, 1024)).toBe(true);
    expect(shouldBlockSpawn(2048, 1024)).toBe(false);
    expect(shouldBlockSpawn(0, 0)).toBe(false); // watermark disabled
  });
});
