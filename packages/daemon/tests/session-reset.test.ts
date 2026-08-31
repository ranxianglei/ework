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
} from "../src/trackers/types";

// Web 🔄 reset button: dispatch-state carries sessionResetMs; execProcess must
// consume a NEWER marker by clearing session pointers exactly once, so the next
// spawn starts fresh without losing the session rows/history.

const FAKE_BIN = join(tmpdir(), "fake-opencode-reset.sh");

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

function makeConfig(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase },
    daemon: { ...cfg.daemon, wakeLogins: ["dog"], noWakeLogins: [], nonWakingAuthors: [] },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000 },
  };
}

let gateResetMs = 0;

async function bootEngine(): Promise<{ engine: Engine; store: Store }> {
  const store = new Store();
  const daemonId = await store.registerDaemon("host-reset", "127.0.0.1:0", 4, 60_000);
  const engine = new Engine(cfgOf(), store, trackerRegistry, {
    daemonId,
    gateChecker: async () => ({ allowed: true, reason: "test", resetMs: gateResetMs }),
  });
  liveEngines.push(engine);
  return { engine, store };
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

const REF: TrackerRef = {
  trackerType: "gitea",
  scope: { owner: "ranxianglei", repo: "billion-context" },
  issueId: "361",
};

function commentEvent(body: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: REF,
    issue: { title: "t", body: "", state: "open", author: "dog" },
    comment: { id: `c${Math.random().toString(36).slice(2, 8)}`, body, author: "dog" },
  };
}

beforeAll(async () => {
  writeFileSync(FAKE_BIN, "#!/bin/sh\nsleep 0.3\nexit 0\n");
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

  workdirBase = mkdtempSync(join(tmpdir(), "ewsr-"));
  gateResetMs = 0;
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

describe("web session reset (🔄 button)", () => {
  test("newer marker clears pointers exactly once", async () => {
    const { engine, store } = await bootEngine();
    const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
    const session = await store.createSession(issue.id, "ework-daemon");
    await store.updateSession(session.id, { opencodeSessionId: "ses_old123" });

    const marker = Date.now();
    gateResetMs = marker;
    await engine.handleEvent(commentEvent("first"), undefined);
    await new Promise((r) => setTimeout(r, 600));

    const rows = await store.getSessionsForIssue(issue.id);
    expect(rows[0]?.opencodeSessionId !== "ses_old123").toBe(true);
    expect(await store.getIssueResetAt(issue.id)).toBe(marker);

    const spawned = await store.getSessionsForIssue(issue.id);
    const newPointer = spawned[0]?.opencodeSessionId;
    expect(newPointer === undefined || newPointer === null || newPointer !== "ses_old123").toBe(true);

    gateResetMs = marker;
    await engine.handleEvent(commentEvent("second"), undefined);
    await new Promise((r) => setTimeout(r, 600));
    expect(await store.getIssueResetAt(issue.id)).toBe(marker);
  });

  test("stale marker (same or older) does not clear a fresh pointer again", async () => {
    const { engine, store } = await bootEngine();
    const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
    const session = await store.createSession(issue.id, "ework-daemon");
    await store.updateSession(session.id, { opencodeSessionId: "ses_keep456" });
    await store.setIssueResetAt(issue.id, 999_999);

    gateResetMs = 999_999;
    await engine.handleEvent(commentEvent("nudge"), undefined);
    await new Promise((r) => setTimeout(r, 600));

    const rows = await store.getSessionsForIssue(issue.id);
    expect(rows[0]?.opencodeSessionId === "ses_keep456" || rows[0]?.opencodeSessionId === undefined).toBe(true);
  });
});
