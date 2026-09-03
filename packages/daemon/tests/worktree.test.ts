/**
 * Worktree-mode acquisition tests (RecloneStrategy).
 *
 * Disk-full incident 2026-09-02: 228 per-issue full clones of billion-context
 * consumed 16GB (58GB disk at 100%). cloneMode=worktree shares the object
 * store via one bare clone per repo + `git worktree add` per issue dir.
 * These tests pin: worktree acquisition shape, shared bare reuse, the
 * plain-clone fallback mode, and the resume short-circuit.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RecloneStrategy } from "../src/opencode";
import type { Config } from "../src/config";
import type { Issue, OpSession } from "../src/trackers/types";

const root = mkdtempSync(join(tmpdir(), "ework-worktree-test-"));
const base = join(root, "base");
const origin = join(root, "origin.git");

function git(args: string[]) {
  const r = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdout: "ignore", stderr: "ignore",
  });
  return r.exitCode ?? -1;
}

function mkConfig(mode: "worktree" | "clone"): Config {
  return {
    opencode: { cloneMode: mode, baseWorkdir: base },
    gitea: { url: "http://unused.local" },
  } as unknown as Config;
}

function mkIssue(n: number): Issue {
  return {
    id: `issue-${n}`,
    trackerType: "gitea",
    trackerScope: { owner: "ranxianglei", repo: "wt-fixture" },
    trackerScopeKey: "ranxianglei/wt-fixture",
    trackerIssueId: String(n),
    state: "active",
    title: "t",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Issue;
}

function mkSession(name: string, workdir?: string): OpSession {
  return { id: 1, uid: `s-${name}`, name, state: "idle", workdir } as unknown as OpSession;
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

beforeAll(() => {
  git(["init", "--bare", "-b", "main", origin]);
  const src = join(root, "src");
  git(["init", "-b", "main", src]);
  writeFileSync(join(src, "hello.txt"), "worktree-fixture\n");
  git(["-C", src, "add", "."]);
  git(["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
  git(["-C", src, "push", origin, "main"]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("worktree mode", () => {
  test("acquires a worktree sharing one bare store", async () => {
    const strat = new RecloneStrategy(mkConfig("worktree"));
    const dir = await strat.acquireWorkdir(mkSession("ework-daemon"), mkIssue(7), origin);
    // worktree marker: .git is a FILE pointing at the shared store
    expect(isFile(join(dir, ".git"))).toBe(true);
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toContain("worktree-fixture");
    const shared = join(base, "ranxianglei--wt-fixture", ".refs.git");
    expect(isFile(join(shared, "HEAD"))).toBe(true);
  });

  test("second issue reuses the same bare store", async () => {
    const strat = new RecloneStrategy(mkConfig("worktree"));
    const d1 = await strat.acquireWorkdir(mkSession("ework-daemon"), mkIssue(8), origin);
    const d2 = await strat.acquireWorkdir(mkSession("ework-daemon"), mkIssue(9), origin);
    expect(isFile(join(d1, ".git"))).toBe(true);
    expect(isFile(join(d2, ".git"))).toBe(true);
    expect(existsSync(join(base, "ranxianglei--wt-fixture", ".refs.git", "HEAD"))).toBe(true);
  });

  test("clone mode produces a full clone (.git directory)", async () => {
    const strat = new RecloneStrategy(mkConfig("clone"));
    const dir = await strat.acquireWorkdir(mkSession("ework-daemon"), mkIssue(10), origin);
    expect(statSync(join(dir, ".git")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toContain("worktree-fixture");
  });

  test("preset session.workdir short-circuits", async () => {
    const strat = new RecloneStrategy(mkConfig("worktree"));
    const preset = join(root, "preset-dir");
    const dir = await strat.acquireWorkdir(mkSession("ework-daemon", preset), mkIssue(11), origin);
    expect(dir).toBe(preset);
  });
});
