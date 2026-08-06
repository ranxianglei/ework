import { beforeAll, beforeEach, afterEach, describe, test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../src/op";
import { Engine, type TakeoverStrategy, type GroupConfig } from "../src/opencode";
import { initDB, getDB } from "../src/db";
import { loadConfig, type Config } from "../src/config";
import type {
  IssueTracker,
  TrackerRef,
  TrackerEvent,
  TrackerComment,
  TrackerInstructions,
  Issue,
  OpSession,
} from "../src/trackers/types";

// Lifecycle tests for Engine.handleClosed (opencode.ts:621-667).
//
// handleClosed is private; it is invoked internally by handleEvent when the
// event type is `issue_closed`. So every test fires `engine.handleEvent(
// closedEvent, groupConfig)` and asserts on observable outcomes (DB state,
// files written by destroyScript, runtime map state, takeover call counts).
//
// Covers the four round-1 bug classes that lived in this code path:
//   - TOCTOU on issue state (now guarded by the `issue.state === "closed"`
//     early return at opencode.ts:628)
//   - non-idempotent close (same guard)
//   - destroyScript ran N× per session (now deduped via Set, opencode.ts:655)
//   - close triggered git clone (now uses pure workdirPathFor instead of
//     resolveWorkdir, opencode.ts:657)
// Plus the round-1 fix that added groupConfigs cleanup (opencode.ts:664).

const FAKE_BIN = join(tmpdir(), "fake-opencode-handle-closed.sh");
const LEASE_TTL_MS = 60_000;
const HEARTBEAT_MS = 10_000;

let workdirBase: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  // handleClosed never spawns opencode (it KILLS processes, doesn't start
  // them), but the Engine constructor fires `void this.recover()` which can
  // spawn if it finds stuck messages. Provide a no-op binary so any
  // incidental spawn is harmless.
  writeFileSync(
    FAKE_BIN,
    `#!/bin/sh
exit 0
`,
  );
  chmodSync(FAKE_BIN, 0o755);
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["messages", "op_sessions", "issues", "daemons"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");

  workdirBase = mkdtempSync(join(tmpdir(), "ewhc-"));
  fakeTracker = new FakeTracker();
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(fakeTracker.type, fakeTracker);
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
});

// FakeTracker: minimal in-process IssueTracker. handleClosed never calls
// tracker methods (no createComment, no listComments) so all methods are
// stubs. isBotUser returns false to keep recover()/finishRun paths benign
// if anything surprising happens.
class FakeTracker implements IssueTracker {
  readonly type = "gitea";

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }
  async createComment(): Promise<{ id: string }> { return { id: "c1" }; }
  async editComment(): Promise<void> {}
  async deleteComment(): Promise<void> {}
  async listComments(): Promise<TrackerComment[]> { return []; }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setReaction(): Promise<void> {}
  getTrackerInstructions(): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }
  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
}

// CountingTakeoverStrategy: mkdir-only acquireWorkdir that records every
// call. In production RecloneStrategy.acquireWorkdir (opencode.ts:122-131)
// spawns `git clone` when the directory is empty. handleClosed must use
// `workdirPathFor` (pure path computation) instead of `resolveWorkdir`
// (which would call acquireWorkdir → git clone). If close starts invoking
// acquireWorkdir, scenario 3 fails.
class CountingTakeoverStrategy implements TakeoverStrategy {
  acquireCalls = 0;
  constructor(private baseWorkdir: string) {}
  async acquireWorkdir(session: OpSession, issue: Issue): Promise<string> {
    this.acquireCalls++;
    const dir = join(this.baseWorkdir, String(issue.trackerIssueId), session.name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  async resumeOpenCodeSession(): Promise<string | null> { return null; }
}

function makeConfig(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase },
    work: { capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(
  store: Store,
  cfg: Config,
  strategy: CountingTakeoverStrategy,
): Promise<{ engine: Engine; daemonId: number }> {
  await store.releaseDeadOwners(cfg.work.leaseTtlMs);
  const daemonId = await store.registerDaemon(
    "host-handle-closed",
    "127.0.0.1:0",
    cfg.work.capacity,
    cfg.work.leaseTtlMs,
  );
  await store.claimAllOwnerless(daemonId);
  const engine = new Engine(cfg, store, trackerRegistry, {
    daemonId, gateChecker: async () => ({ allowed: true, reason: "test" }),
    takeover: strategy,
  });
  liveEngines.push(engine);
  return { engine, daemonId };
}

// Pre-create an issue directly in the store so handleClosed's `findIssue`
// (opencode.ts:626) finds it. Issue is left unclaimed — handleClosed does
// NOT check ownership, and leaving it unclaimed prevents the engine's
// recover() from iterating it.
async function seedIssue(
  store: Store,
  issueId: string,
  owner = "dog",
  repo = "repo",
): Promise<Issue> {
  const ref: TrackerRef = { trackerType: "gitea", scope: { owner, repo }, issueId };
  const issue = await store.findOrCreateIssue(ref, `${owner}/${repo}`, `title-${issueId}`);
  await store.updateIssueState(issue.id, "active");
  issue.state = "active";
  return issue;
}

async function seedSession(
  store: Store,
  issue: Issue,
  name: string,
  workdir?: string,
): Promise<OpSession> {
  const session = await store.createSession(issue.id, name);
  if (workdir) {
    await store.updateSession(session.id, { workdir });
    session.workdir = workdir;
  }
  return session;
}

function closedEvent(issueId: string, owner = "dog", repo = "repo"): TrackerEvent {
  return {
    type: "issue_closed",
    ref: { trackerType: "gitea", scope: { owner, repo }, issueId },
    issue: { title: `title-${issueId}`, body: "", state: "closed", author: "tester" },
  };
}

function markerPath(label: string): string {
  return join(tmpdir(), `ewhc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
}

function lineCount(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// Accessor for the private groupConfigs Map. TS `private` is compile-time
// only; runtime bracket access works.
function groupConfigsMap(engine: Engine): Map<string, GroupConfig> {
  return (engine as unknown as { groupConfigs: Map<string, GroupConfig> }).groupConfigs;
}

// ─── Scenarios ───

describe("handleClosed: basic close runs destroyScript once per workdir", () => {
  test("destroyScript runs and produces the expected side effect", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const strategy = new CountingTakeoverStrategy(workdirBase);
    const { engine } = await bootEngine(store, cfg, strategy);

    const issue = await seedIssue(store, "100");
    const workdir = join(workdirBase, "wd-100");
    mkdirSync(workdir, { recursive: true });
    await seedSession(store, issue, "ework-daemon-test", workdir);

    const marker = markerPath("destroy");
    try {
      const gc: GroupConfig = { destroyScript: `touch ${marker}` };
      await engine.handleEvent(closedEvent("100"), gc);

      const refreshed = await store.findIssue("gitea", "dog/repo", "100");
      expect(refreshed?.state).toBe("closed");
      expect(existsSync(marker)).toBe(true);
    } finally {
      try { rmSync(marker); } catch { /* gone */ }
    }
  });
});

describe("handleClosed: duplicate close is a no-op", () => {
  test("destroyScript runs exactly once when issue_closed fires twice", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const strategy = new CountingTakeoverStrategy(workdirBase);
    const { engine } = await bootEngine(store, cfg, strategy);

    const issue = await seedIssue(store, "200");
    const workdir = join(workdirBase, "wd-200");
    mkdirSync(workdir, { recursive: true });
    await seedSession(store, issue, "ework-daemon-test", workdir);

    const counter = markerPath("count").replace(/\.txt$/, ".log");
    try {
      const gc: GroupConfig = { destroyScript: `echo x >> ${counter}` };

      // First close: state active → closed. Second close hits the
      // `issue.state === "closed"` early return at opencode.ts:628 and MUST
      // NOT re-run destroyScript — regression guard for the round-1 TOCTOU
      // + non-idempotent-close bugs.
      await engine.handleEvent(closedEvent("200"), gc);
      await engine.handleEvent(closedEvent("200"), gc);

      expect(lineCount(counter)).toBe(1);
    } finally {
      try { rmSync(counter); } catch { /* gone */ }
    }
  });
});

describe("handleClosed: no git clone on close (regression for round-1 bug #4)", () => {
  test("acquireWorkdir is never invoked during close", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const strategy = new CountingTakeoverStrategy(workdirBase);
    const { engine } = await bootEngine(store, cfg, strategy);

    const issue = await seedIssue(store, "300");
    const workdir = join(workdirBase, "wd-300");
    mkdirSync(workdir, { recursive: true });
    await seedSession(store, issue, "ework-daemon-test", workdir);

    // groupConfig has destroyScript but NO workdirTemplate. handleClosed
    // must compute the workdir via workdirPathFor (pure path math) and must
    // NOT call resolveWorkdir → takeover.acquireWorkdir (which spawns
    // `git clone` in production RecloneStrategy when the dir is empty).
    const gc: GroupConfig = { destroyScript: "true" };
    await engine.handleEvent(closedEvent("300"), gc);

    expect(strategy.acquireCalls).toBe(0);
  });
});

describe("handleClosed: destroyScript dedup when template omits {session}", () => {
  test("three sessions resolving to one shared workdir run destroyScript once", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const strategy = new CountingTakeoverStrategy(workdirBase);
    const { engine } = await bootEngine(store, cfg, strategy);

    const issue = await seedIssue(store, "400");
    // Template WITHOUT {session} → all sessions resolve to the same path.
    // Use an absolute path so resolveTemplatedWorkdir returns it verbatim
    // regardless of owner/repo/issue/session substitution.
    const sharedWorkdir = join(workdirBase, "shared-400");
    mkdirSync(sharedWorkdir, { recursive: true });

    // Three sessions, no per-session workdir → workdirPathFor falls through
    // to the groupConfig template branch for all three.
    await seedSession(store, issue, "agent-a");
    await seedSession(store, issue, "agent-b");
    await seedSession(store, issue, "agent-c");

    const counter = markerPath("dedup").replace(/\.txt$/, ".log");
    try {
      const gc: GroupConfig = {
        workdirTemplate: sharedWorkdir,
        destroyScript: `echo x >> ${counter}`,
      };
      await engine.handleEvent(closedEvent("400"), gc);

      // The dedup Set at opencode.ts:655 collapses 3 sessions to 1 workdir;
      // destroyScript runs exactly once. A regression that loops over
      // sessions instead of the Set would produce 3 lines.
      expect(lineCount(counter)).toBe(1);
    } finally {
      try { rmSync(counter); } catch { /* gone */ }
    }
  });
});

describe("handleClosed: groupConfigs Map cleanup", () => {
  test("the groupConfig entry is deleted after close completes", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const strategy = new CountingTakeoverStrategy(workdirBase);
    const { engine } = await bootEngine(store, cfg, strategy);

    const issue = await seedIssue(store, "500");
    const workdir = join(workdirBase, "wd-500");
    mkdirSync(workdir, { recursive: true });
    await seedSession(store, issue, "ework-daemon-test", workdir);

    const gcKey = `gitea:dog/repo#500`;
    const gc: GroupConfig = { destroyScript: "true" };

    await engine.handleEvent(closedEvent("500"), gc);

    // Cleanup at opencode.ts:664 removes the entry so subsequent events for
    // this issue don't see a stale groupConfig.
    const map = groupConfigsMap(engine);
    expect(map.size).toBe(0);
    expect(map.has(gcKey)).toBe(false);
  });
});
