import { beforeAll, beforeEach, afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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
} from "../src/trackers/types";

// Stale-pending expiry: messages that sat queued longer than MAX_PENDING_AGE_MS
// must be expired, not replayed (echo-storm leftovers replaying hours later
// produced a reply/nudge ping-pong on dog/tasks#3). Explicit retries bypass.

const FAKE_BIN = join(tmpdir(), "fake-opencode-stale.sh");

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
  getTrackerInstructions(): TrackerInstructions { return { clone: "git clone fake", issueRef: "fake/ref" }; }
  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
  resolveWorkdir(_issue: Issue, _session: OpSession): string {
    return join(workdirBase, String(_issue.trackerIssueId), _session.name);
  }
  async resumeOpenCodeSession(): Promise<string | null> { return null; }
}

function cfgOf(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase },
    daemon: { ...cfg.daemon, wakeLogins: ["dog"], noWakeLogins: [], nonWakingAuthors: [] },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000 },
  };
}

async function bootEngine(): Promise<{ engine: Engine; store: Store }> {
  const store = new Store();
  const daemonId = await store.registerDaemon("host-stale", "127.0.0.1:0", 4, 60_000);
  const engine = new Engine(cfgOf(), store, trackerRegistry, {
    daemonId,
    gateChecker: async () => ({ allowed: true, reason: "test", resetMs: 0 }),
  });
  liveEngines.push(engine);
  return { engine, store };
}

const REF: TrackerRef = {
  trackerType: "gitea",
  scope: { owner: "ranxianglei", repo: "billion-context" },
  issueId: "361",
};

const KEY = "gitea:ranxianglei/billion-context#361@ework-daemon";

async function backdate(uid: string, minutes: number): Promise<void> {
  const past = new Date(Date.now() - minutes * 60_000).toISOString();
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", [past, uid]);
}

async function eventually(assert: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await assert(); return; } catch (err) {
      if (Date.now() > deadline) throw err;
      await Bun.sleep(25);
    }
  }
}

beforeAll(async () => {
  writeFileSync(FAKE_BIN, "#!/bin/sh\nsleep 0.3\nexit 0\n");
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

  workdirBase = mkdtempSync(join(tmpdir(), "ewst-"));
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

describe("stale pending expiry", () => {
  test("message queued past the age limit is expired, not replayed", async () => {
    const { engine, store } = await bootEngine();
    const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
    const session = await store.createSession(issue.id, "ework-daemon");
    const msg = await store.createMessage(session.id, "[SYSTEM FORWARD] storm leftover");
    await backdate(msg.id, 45);

    await (engine as unknown as { deactivateIfIdle: (k: string, s: OpSession, i: Issue) => Promise<void> }).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "failed" || !row.error?.includes("expired")) throw new Error(`status=${row?.status}`);
    });
    expect((await engine.getStatus()).runningCount).toBe(0);
    const after = await store.getSession(session.id);
    expect(after?.state).toBe("idle");
  });

  test("fresh pending message still runs", async () => {
    const { engine, store } = await bootEngine();
    const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
    const session = await store.createSession(issue.id, "ework-daemon");
    const msg = await store.createMessage(session.id, "[SYSTEM FORWARD] fresh work");
    await backdate(msg.id, 5);

    await (engine as unknown as { deactivateIfIdle: (k: string, s: OpSession, i: Issue) => Promise<void> }).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "running") throw new Error(`status=${row?.status}`);
      if ((await engine.getStatus()).runningCount !== 1) throw new Error("not running");
    });
  });

  test("mixed queue: stale entries expire, the fresh one runs", async () => {
    const { engine, store } = await bootEngine();
    const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
    const session = await store.createSession(issue.id, "ework-daemon");
    const stale1 = await store.createMessage(session.id, "[SYSTEM FORWARD] storm a");
    const stale2 = await store.createMessage(session.id, "[SYSTEM FORWARD] storm b");
    const fresh = await store.createMessage(session.id, "[SYSTEM FORWARD] fresh");
    await backdate(stale1.id, 60);
    await backdate(stale2.id, 45);
    await backdate(fresh.id, 2);

    await (engine as unknown as { deactivateIfIdle: (k: string, s: OpSession, i: Issue) => Promise<void> }).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      expect((await store.getMessage(stale1.id))?.status).toBe("failed");
      expect((await store.getMessage(stale2.id))?.status).toBe("failed");
      const freshRow = await store.getMessage(fresh.id);
      if (freshRow?.status !== "running") throw new Error(`fresh=${freshRow?.status}`);
    });
  });

  test("explicit retry (force) bypasses the age limit", async () => {
    const { engine, store } = await bootEngine();
    const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
    const session = await store.createSession(issue.id, "ework-daemon");
    const msg = await store.createMessage(session.id, "operator wants this re-run");
    await backdate(msg.id, 45);
    await store.updateMessageStatus(msg.id, "failed", "old failure");
    // retryMessage only retries failed rows
    const ok = await engine.retryMessage(msg.id);
    expect(ok).toBe(true);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "running") throw new Error(`status=${row?.status}`);
    });
  });
});
