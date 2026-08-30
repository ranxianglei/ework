import { beforeAll, beforeEach, afterEach, describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../src/op";
import { Engine, isAiGeneratedComment } from "../src/opencode";
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

// AI-marker convention (2026-08-30): machine-authored comments lead with 🏷
// or a [system]/[bot] tag. They must never wake the agent or be replied to.

const FAKE_BIN = join(tmpdir(), "fake-opencode-ai-marker.sh");

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
    daemon: { ...cfg.daemon, wakeLogins: [], noWakeLogins: [], nonWakingAuthors: [] },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000 },
  };
}

async function bootEngine(): Promise<{ engine: Engine; store: Store }> {
  const store = new Store();
  const daemonId = await store.registerDaemon("host-ai-marker", "127.0.0.1:0", 4, 60_000);
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

function commentEvent(body: string, author = "outsider"): TrackerEvent {
  return {
    type: "comment_created",
    ref: REF,
    issue: { title: "marker test", body: "issue body", state: "open", author: "opener" },
    comment: { id: `c-${body.length}-${Date.now()}`, body, author },
  };
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

  workdirBase = mkdtempSync(join(tmpdir(), "eaim-"));
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

describe("isAiGeneratedComment", () => {
  test("recognizes the marker shapes", () => {
    expect(isAiGeneratedComment("🏷 [ses_1](/sessions/ses_1) ✓ Message forwarded to **awork** (running).")).toBe(true);
    expect(isAiGeneratedComment("  🏷 leading whitespace is tolerated")).toBe(true);
    expect(isAiGeneratedComment("[system] 🏷 [ses_1](/sessions/ses_1) ✓ forwarded")).toBe(true);
    expect(isAiGeneratedComment("[SYSTEM] ✅ **awork** completed (6 min)")).toBe(true);
    expect(isAiGeneratedComment("[bot] fixed in commit abc123")).toBe(true);
    expect(isAiGeneratedComment("[bot] 🏷 with emoji")).toBe(true);
  });

  test("human speech passes through", () => {
    expect(isAiGeneratedComment("还是不行,再看看")).toBe(false);
    expect(isAiGeneratedComment("test [bot] not at start")).toBe(false);
    expect(isAiGeneratedComment("")).toBe(false);
  });
});

describe("AI-marker gate", () => {
  test("marker comment does not wake the agent", async () => {
    const { engine, store } = await bootEngine();
    await engine.handleEvent(commentEvent("[system] 🏷 [ses_1](/sessions/ses_1) ✓ Message forwarded to **awork** (running)."));
    await Bun.sleep(150);

    const issues = await store.listAllIssues();
    const sessions = await getDB().all("SELECT * FROM {{op_sessions}}");
    const messages = await getDB().all("SELECT * FROM {{messages}}");
    expect(issues.length).toBe(0);
    expect(sessions.length).toBe(0);
    expect(messages.length).toBe(0);
    expect((await engine.getStatus()).runningCount).toBe(0);
  });

  test("bare 🏷 comment from another bot is ignored too", async () => {
    const { engine } = await bootEngine();
    await engine.handleEvent(commentEvent("🏷 观察到循环了,已自动停止", "other-agent"));
    await Bun.sleep(150);
    expect((await getDB().all("SELECT * FROM {{messages}}")).length).toBe(0);
  });

  test("human comment still wakes the agent", async () => {
    const { engine } = await bootEngine();
    await engine.handleEvent(commentEvent("请回复一个 ok"));
    await eventually(async () => {
      const messages = await getDB().all("SELECT * FROM {{messages}}");
      if (messages.length !== 1) throw new Error(`messages=${messages.length}`);
      expect((await engine.getStatus()).runningCount).toBe(1);
    });
  });
});
