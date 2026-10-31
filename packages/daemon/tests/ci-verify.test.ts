import { beforeAll, beforeEach, afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../src/op";
import { Engine } from "../src/opencode";
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
  Message,
} from "../src/trackers/types";

// CI-lane post-fix verification (audit RC3): a DONE lane message means "a fix
// attempt finished", not "checks turned green". The daemon waits
// ciVerifyDelayMs, then asks the web mirror (GET /api/v1/upstream-checks) for
// the verdict:
//   GREEN           → ONE `[ework] CI fix verified green ✓`; entry removed.
//   still RED ×2    → `[ework] auto-fix stalled: …` + ONE ⛔ cap/decision
//                     notice (same throttle path as auto-lane degradation),
//                     lane parked while the head sha is unchanged.
//   no evidence     → reschedule without burning the red budget; dropped
//                     after 3 passes.
// After a restart the queue rebuilds from recent done lane rows in the DB.

const FAKE_BIN_OK = join(tmpdir(), "fake-opencode-civerify-ok.sh");

let workdirBase: string;
let tracker: RecordingTracker;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

class RecordingTracker implements IssueTracker {
  readonly type = "gitea";
  readonly comments: string[] = [];

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }
  async createComment(_ref: TrackerRef, body: string): Promise<TrackerComment> {
    this.comments.push(body);
    return { id: `c${this.comments.length}`, body, author: "ework-daemon", createdAt: new Date().toISOString() };
  }
  async editComment(): Promise<void> {}
  async deleteComment(): Promise<void> {}
  async listComments(): Promise<TrackerComment[]> { return []; }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setCommentModel(): Promise<void> {}
  async setReaction(): Promise<void> {}
  async setIssueReaction(): Promise<void> {}
  getTrackerInstructions(): TrackerInstructions { return { clone: "git clone fake", issueRef: "fake/ref" }; }
  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
  resolveWorkdir(_issue: Issue, _session: OpSession): string {
    return join(workdirBase, String(_issue.trackerIssueId), _session.name);
  }
  async resumeOpenCodeSession(): Promise<string | null> { return null; }
}

const REF: TrackerRef = {
  trackerType: "gitea",
  scope: { owner: "ranxianglei", repo: "billion-context" },
  issueId: "700",
};
const SCOPE_KEY = "ranxianglei/billion-context";
const VERIFY_KEY = `${SCOPE_KEY}#700`;
const SHA_A = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const SHA_B = "ff00ee11dd22cc33bb44aa55ff00ee11dd22cc33";

type CheckRow = { name: string; status: string; conclusion: string };
const OK_CHECKS: CheckRow[] = [
  { name: "test", status: "completed", conclusion: "success" },
  { name: "lint", status: "completed", conclusion: "success" },
];
const RED_CHECKS: CheckRow[] = [{ name: "test", status: "completed", conclusion: "failure" }];

type Snapshot = null | { sha?: string; fetched_at?: string; checks: CheckRow[] };

/** Fake e-work-web serving GET /api/v1/upstream-checks from mutable state. */
function startFakeWeb(initial: Snapshot): { port: number; state: { snap: Snapshot }; stop: () => void } {
  const state: { snap: Snapshot } = { snap: initial };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/v1/upstream-checks") {
        const s = state.snap;
        if (!s) return Response.json({ error: "no cached checks" }, { status: 404 });
        const total = s.checks.length;
        const failed = s.checks.filter((c) => c.conclusion === "failure").length;
        const pending = s.checks.filter((c) => c.status !== "completed").length;
        return Response.json({
          sha: s.sha ?? null,
          fetched_at: s.fetched_at ?? new Date().toISOString(),
          checks: s.checks,
          summary: { total, failed, pending },
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("fake web failed to bind");
  return { port, state, stop: () => server.stop() };
}

interface BootOpts {
  web?: string;
  work?: Partial<Config["work"]>;
}

async function bootEngine(opts: BootOpts = {}): Promise<{ engine: Engine; store: Store; daemonId: number }> {
  const cfg = loadConfig();
  const full: Config = {
    ...cfg,
    gitea: { ...cfg.gitea, url: opts.web ?? "" },
    opencode: { ...cfg.opencode, binary: FAKE_BIN_OK, baseWorkdir: workdirBase },
    daemon: { ...cfg.daemon, wakeLogins: ["dog"], noWakeLogins: [], nonWakingAuthors: [] },
    // Tiny verify ladder: 30ms first-check delay, 40ms retry interval.
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000, ciVerifyDelayMs: 30, ciVerifyRetryMs: 40, ...(opts.work ?? {}) },
  };
  const store = new Store();
  const daemonId = await store.registerDaemon("host-civerify", "127.0.0.1:0", 4, 60_000);
  const engine = new Engine(full, store, trackerRegistry, {
    daemonId,
    gateChecker: async () => ({ allowed: true, reason: "test", resetMs: 0 }),
  });
  liveEngines.push(engine);
  return { engine, store, daemonId };
}

async function seedLaneMsg(store: Store, scid: string, status: Message["status"] = "done"): Promise<Message> {
  const issue = await store.findOrCreateIssue(REF, SCOPE_KEY, "ci fix subject");
  const session = await store.createSession(issue.id, "ci-worker");
  const msg = await store.createMessage(session.id, "[SYSTEM FORWARD] ci fix", scid);
  if (status !== "pending") await store.updateMessageStatus(msg.id, status);
  return msg;
}

type EnginePriv = {
  ciVerifyQueue: Map<string, { pr: number; sha?: string; attempt: number; transient: number; nextCheckAt: number }>;
  ciVerifyExhausted: Map<string, { sha?: string; at: number }>;
  isLaneExhausted: (scopeKey: string, sourceCommentId: string | undefined) => boolean;
};
const priv = (e: Engine) => e as unknown as EnginePriv;

beforeAll(async () => {
  writeFileSync(FAKE_BIN_OK, "#!/bin/sh\nsleep 0.1\nexit 0\n");
  chmodSync(FAKE_BIN_OK, 0o755);
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

  workdirBase = mkdtempSync(join(tmpdir(), "ewciverify-"));
  tracker = new RecordingTracker();
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(tracker.type, tracker);
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
});

describe("CI-lane post-fix verification (audit RC3)", () => {
  test("green: posts exactly one verified-green comment and clears the entry", async () => {
    const web = startFakeWeb({ sha: SHA_A, checks: OK_CHECKS });
    try {
      const { engine, store } = await bootEngine({ web: `http://127.0.0.1:${web.port}` });
      const msg = await seedLaneMsg(store, `ci-fail-700-${SHA_A}`);
      await engine.scheduleCiVerify(msg);
      expect(priv(engine).ciVerifyQueue.get(VERIFY_KEY)?.pr).toBe(700);
      expect(priv(engine).ciVerifyQueue.get(VERIFY_KEY)?.sha).toBe(SHA_A);

      await Bun.sleep(60); // delay (30ms) elapsed
      await engine.runCiVerifySweep();

      expect(tracker.comments.length).toBe(1);
      expect(tracker.comments[0]).toContain("[ework] CI fix verified green ✓");
      expect(priv(engine).ciVerifyQueue.size).toBe(0);
    } finally {
      web.stop();
    }
  });

  test("red then green: first round reschedules, second round verifies", async () => {
    const web = startFakeWeb({ sha: SHA_A, checks: RED_CHECKS });
    try {
      const { engine, store } = await bootEngine({ web: `http://127.0.0.1:${web.port}` });
      const msg = await seedLaneMsg(store, `ci-fail-700-${SHA_A}`);
      await engine.scheduleCiVerify(msg);

      await Bun.sleep(60);
      await engine.runCiVerifySweep();
      // Attempt 1 consumed, no comment yet — the fix may simply not be in
      // the cached snapshot (or the suite still running).
      expect(tracker.comments.length).toBe(0);
      expect(priv(engine).ciVerifyQueue.get(VERIFY_KEY)?.attempt).toBe(1);

      // The retried fix turns the suite green → next due round closes out.
      web.state.snap = { sha: SHA_A, fetched_at: new Date().toISOString(), checks: OK_CHECKS };
      await Bun.sleep(80);
      await engine.runCiVerifySweep();

      expect(tracker.comments.filter((c) => c.includes("CI fix verified green ✓")).length).toBe(1);
      expect(priv(engine).ciVerifyQueue.size).toBe(0);
    } finally {
      web.stop();
    }
  });

  test("exhausted: two red rounds → stall comment + ONE ⛔ notice, lane parked until sha changes", async () => {
    const web = startFakeWeb({ sha: SHA_A, checks: RED_CHECKS });
    try {
      const { engine, store } = await bootEngine({ web: `http://127.0.0.1:${web.port}` });
      const msg = await seedLaneMsg(store, `ci-fail-700-${SHA_A}`);
      await engine.scheduleCiVerify(msg);

      await Bun.sleep(60);
      await engine.runCiVerifySweep();
      expect(tracker.comments.length).toBe(0);
      expect(priv(engine).ciVerifyQueue.get(VERIFY_KEY)?.attempt).toBe(1);

      await Bun.sleep(80);
      await engine.runCiVerifySweep();

      // Exactly two notices: the stall comment and the decision-request cap
      // notice (reusing the auto-lane degradation throttle path).
      expect(tracker.comments.length).toBe(2);
      expect(tracker.comments[0]).toContain("[ework] auto-fix stalled:");
      expect(tracker.comments[0]).toContain("test"); // failing check name
      expect(tracker.comments[0]).toContain("stopping for human review");
      expect(tracker.comments[1]).toContain("⛔");
      expect(tracker.comments[1]).toContain("车道已达上限");
      expect(priv(engine).ciVerifyQueue.size).toBe(0);
      expect(priv(engine).ciVerifyExhausted.get(VERIFY_KEY)?.sha).toBe(SHA_A);

      // Parked: same sha blocked…
      expect(priv(engine).isLaneExhausted(SCOPE_KEY, `ci-fail-700-${SHA_A}`)).toBe(true);
      // …new head sha releases the lane…
      expect(priv(engine).isLaneExhausted(SCOPE_KEY, `ci-fail-700-${SHA_B}`)).toBe(false);
      // …and lanes whose scid tail carries no sha never lock anyone out.
      expect(priv(engine).isLaneExhausted(SCOPE_KEY, "merge-guard-700-1793030000000")).toBe(false);

      // Later sweeps stay silent (no comment spam per tick).
      await engine.runCiVerifySweep();
      expect(tracker.comments.length).toBe(2);

      // A fresh cycle on the NEW sha resets the exhaustion marker.
      const msgB = await seedLaneMsg(store, `ci-fail-700-${SHA_B}`);
      await engine.scheduleCiVerify(msgB);
      expect(priv(engine).ciVerifyExhausted.has(VERIFY_KEY)).toBe(false);
      expect(priv(engine).ciVerifyQueue.get(VERIFY_KEY)?.sha).toBe(SHA_B);
    } finally {
      web.stop();
    }
  });

  test("restart: done lane rows in the DB rebuild the pending verify queue", async () => {
    const web = startFakeWeb({ sha: SHA_A, checks: OK_CHECKS });
    try {
      // "Before restart": a ci-fail lane message reached done but the
      // verification never ran (daemon went away).
      const w1 = await bootEngine({ web: `http://127.0.0.1:${web.port}` });
      await seedLaneMsg(w1.store, `ci-fail-700-${SHA_A}`);
      w1.engine.destroy();
      liveEngines.splice(liveEngines.indexOf(w1.engine), 1);

      // "After restart": brand-new engine, empty in-memory queue.
      const w2 = await bootEngine({ web: `http://127.0.0.1:${web.port}` });
      expect(priv(w2.engine).ciVerifyQueue.size).toBe(0);

      await Bun.sleep(60); // row's updated_at (+30ms delay) is now due
      await w2.engine.runCiVerifySweep();

      expect(tracker.comments.some((c) => c.includes("CI fix verified green ✓"))).toBe(true);
      expect(priv(w2.engine).ciVerifyQueue.size).toBe(0);
    } finally {
      web.stop();
    }
  });

  test("no evidence: repeated web failures drop the entry quietly (no comments)", async () => {
    const web = startFakeWeb(null); // 404 forever — no cached checks
    try {
      const { engine, store } = await bootEngine({ web: `http://127.0.0.1:${web.port}` });
      const msg = await seedLaneMsg(store, `ci-fail-700-${SHA_A}`);
      await engine.scheduleCiVerify(msg);

      await Bun.sleep(60);
      await engine.runCiVerifySweep();
      expect(priv(engine).ciVerifyQueue.get(VERIFY_KEY)?.transient).toBe(1);

      await Bun.sleep(80);
      await engine.runCiVerifySweep();
      expect(priv(engine).ciVerifyQueue.get(VERIFY_KEY)?.transient).toBe(2);

      await Bun.sleep(80);
      await engine.runCiVerifySweep();
      expect(priv(engine).ciVerifyQueue.size).toBe(0);
      expect(tracker.comments.length).toBe(0);
    } finally {
      web.stop();
    }
  });
});
