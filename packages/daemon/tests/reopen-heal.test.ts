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

// Regression: issue_closed is never wake-gated, but reopened maps to
// issue_opened which IS gated. When an upstream user (not in wakeLogins)
// reopens an issue, the daemon row must still flip back to "active" —
// otherwise the zombie "closed" row swallows every future comment with
// "is closed in DB, skipping comment" (production incident bc#255).

const FAKE_BIN = join(tmpdir(), "fake-opencode-reopen-heal.sh");

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

function makeConfig(wakeLogins: string[]): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase },
    daemon: { ...cfg.daemon, wakeLogins, noWakeLogins: [], nonWakingAuthors: [] },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000 },
  };
}

async function bootEngine(cfg: Config): Promise<{ engine: Engine; store: Store }> {
  const store = new Store();
  const daemonId = await store.registerDaemon("host-reopen-heal", "127.0.0.1:0", cfg.work.capacity, cfg.work.leaseTtlMs);
  const engine = new Engine(cfg, store, trackerRegistry, {
    daemonId,
    gateChecker: async () => ({ allowed: false, reason: "test-blocked" }),
  });
  liveEngines.push(engine);
  return { engine, store };
}

const REF: TrackerRef = {
  trackerType: "gitea",
  scope: { owner: "ranxianglei", repo: "billion-context" },
  issueId: "255",
};

function reopenedEvent(author: string): TrackerEvent {
  return {
    type: "issue_opened",
    ref: REF,
    issue: { title: "t", body: "", state: "open", author },
  };
}

async function seedClosedIssue(store: Store): Promise<void> {
  const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
  await store.updateIssueState(issue.id, "closed");
}

beforeAll(async () => {
  writeFileSync(FAKE_BIN, "#!/bin/sh\nexit 0\n");
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

  workdirBase = mkdtempSync(join(tmpdir(), "ewrh-"));
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

describe("reopened heals stale closed state (bc#255)", () => {
  test("author outside wakeLogins: state healed, no AI work triggered", async () => {
    const cfg = makeConfig(["dog"]);
    const { engine, store } = await bootEngine(cfg);
    await seedClosedIssue(store);

    await engine.handleEvent(reopenedEvent("Rika-xie"), undefined);

    const after = await store.findIssue("gitea", "ranxianglei/billion-context", "255");
    expect(after?.state).toBe("active");
    expect(tracker.comments).toHaveLength(0);
  });

  test("idempotent: second reopened on active row is a no-op", async () => {
    const cfg = makeConfig(["dog"]);
    const { engine, store } = await bootEngine(cfg);
    await seedClosedIssue(store);

    await engine.handleEvent(reopenedEvent("Rika-xie"), undefined);
    await engine.handleEvent(reopenedEvent("Rika-xie"), undefined);

    const after = await store.findIssue("gitea", "ranxianglei/billion-context", "255");
    expect(after?.state).toBe("active");
  });

  test("untracked issue from outside author: never left as closed zombie", async () => {
    const cfg = makeConfig(["dog"]);
    const { engine, store } = await bootEngine(cfg);

    await engine.handleEvent(reopenedEvent("Rika-xie"), undefined);

    const after = await store.findIssue("gitea", "ranxianglei/billion-context", "255");
    expect(after?.state ?? "untracked").not.toBe("closed");
  });

  test("whitelisted author reopens: dispatch proceeds (regression)", async () => {
    const cfg = makeConfig(["dog"]);
    const { engine, store } = await bootEngine(cfg);
    await seedClosedIssue(store);

    await engine.handleEvent(reopenedEvent("dog"), undefined);

    const after = await store.findIssue("gitea", "ranxianglei/billion-context", "255");
    expect(after?.state).toBe("active");
    expect(tracker.comments.length).toBeGreaterThanOrEqual(1);
    expect(tracker.comments[0]).toContain("picked up this issue");
  });
});
