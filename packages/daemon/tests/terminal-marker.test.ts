import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../src/op";
import { Engine, type TakeoverStrategy } from "../src/opencode";
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
import type {
  RuntimeBackend,
  RuntimeHandle,
  RuntimeSpawnOpts,
  RuntimeSpawnCallbacks,
  LastModelResult,
  SessionOutputResult,
} from "../src/runtime/types";

// Terminal-marker placement (dog/tasks#18). The ⏳ progress comment is
// created mid-run; if the thread has moved past it by the time the process
// exits, the terminal ✅ must be posted as a NEW trailing comment (and the
// stale ⏳ dropped), never edited in place out of chronological order.

const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;
const BOT_USER = "ework-daemon";
const HUMAN_USER = "tester";

let workdirBase: string;
let tracker: MarkerTracker;
let backend: MarkerBackend;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

beforeAll(async () => {
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

  workdirBase = `${tmpdir()}/ework-daemon-marker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

  tracker = new MarkerTracker();
  backend = new MarkerBackend(tracker);
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

class MarkerTracker implements IssueTracker {
  readonly type = "gitea";
  comments: TrackerComment[] = [];
  creates: Array<{ id: string; body: string }> = [];
  edits: Array<{ id: string; body: string }> = [];
  deletes: string[] = [];
  private nextId = 1;

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }

  async createComment(_ref: TrackerRef, body: string): Promise<{ id: string }> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body, author: BOT_USER, createdAt: new Date().toISOString() });
    this.creates.push({ id, body });
    return { id };
  }

  async editComment(_ref: TrackerRef, id: string, body: string): Promise<void> {
    this.edits.push({ id, body });
    const hit = this.comments.find((c) => c.id === id);
    if (hit) hit.body = body;
  }

  async deleteComment(_ref: TrackerRef, id: string): Promise<void> {
    this.deletes.push(id);
    this.comments = this.comments.filter((c) => c.id !== id);
  }

  async listComments(): Promise<TrackerComment[]> { return [...this.comments]; }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setCommentModel(): Promise<void> {}
  async setReaction(): Promise<void> {}

  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }

  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(author: string): boolean { return author === BOT_USER; }
}

class TestTakeoverStrategy implements TakeoverStrategy {
  constructor(private baseWorkdir: string) {}
  async acquireWorkdir(session: OpSession, issue: Issue): Promise<string> {
    const dir = join(this.baseWorkdir, String(issue.trackerIssueId), session.name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  async resumeOpenCodeSession(): Promise<string | null> { return null; }
}

/**
 * Fake runtime that always delivers: at t=50ms it appends the ⏳ progress
 * comment and/or the [bot] reply to the thread in the configured order, then
 * the child exits 0 at t=200ms, driving finishRun.
 */
class MarkerBackend implements RuntimeBackend {
  readonly name = "fake";
  progressId = "pc-live";
  plan: Array<"progress" | "reply"> = ["reply"];

  constructor(private tr: MarkerTracker) {}

  async spawn(opts: RuntimeSpawnOpts, callbacks: RuntimeSpawnCallbacks): Promise<RuntimeHandle> {
    const proc = Bun.spawn(["sh", "-c", "sleep 0.2"], { stdout: "ignore", stderr: "ignore" });
    setTimeout(() => {
      for (const step of this.plan) {
        if (step === "progress") {
          this.tr.comments.push({
            id: this.progressId,
            body: "[system] 🏷 ⏳ processing, running for 5 min...",
            author: BOT_USER,
            createdAt: new Date().toISOString(),
          });
        } else {
          this.tr.comments.push({
            id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            body: "[bot] 🏷 done: handled the request",
            author: BOT_USER,
            createdAt: new Date().toISOString(),
          });
        }
      }
      callbacks.onOutput();
    }, 50);
    const exited = proc.exited.then(() => 0);
    return {
      pid: proc.pid,
      exited,
      stderrText: Promise.resolve(""),
      stderrPartial: () => "",
      stderrCancel: () => {},
    };
  }

  async lastSessionModel(): Promise<LastModelResult> { return { model: "fake/model" }; }
  async sessionExists(): Promise<boolean> { return true; }
  async getSessionOutputTokens(): Promise<SessionOutputResult> { return { hasOutput: true, tokenCount: 5 }; }
}

function makeConfig(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: "fake-opencode", baseWorkdir: workdirBase, dbPath: join(workdirBase, "opencode.db") },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(name: string, store: Store, port: number): Promise<Engine> {
  await store.releaseDeadOwners(LEASE_TTL_MS);
  const daemonId = await store.registerDaemon(`host-${name}`, `127.0.0.1:${port}`, 4, LEASE_TTL_MS);
  await store.claimAllOwnerless(daemonId);
  const engine = new Engine(makeConfig(), store, trackerRegistry, {
    daemonId,
    gateChecker: async () => ({ allowed: true, reason: "test" }),
    takeover: new TestTakeoverStrategy(workdirBase),
    backend,
    recoverOnBoot: false,
  });
  engine.startHeartbeat(HEARTBEAT_MS);
  liveEngines.push(engine);
  return engine;
}

function commentEvent(issueId: string, body: string, commentId: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title: "terminal marker test", body: "b", state: "open", author: HUMAN_USER },
    comment: { id: commentId, body, author: HUMAN_USER },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return await predicate();
}

async function noRunningMessages(): Promise<boolean> {
  const rows = await getDB().all<{ status: string }>("SELECT status FROM {{messages}}");
  return rows.every((r) => r.status !== "running" && r.status !== "pending");
}

async function firstSessionUid(): Promise<string> {
  const row = await getDB().get<{ uid: string }>("SELECT uid FROM {{op_sessions}} ORDER BY id LIMIT 1");
  return row!.uid;
}

async function runSecondRound(plan: Array<"progress" | "reply">): Promise<void> {
  const store = new Store();
  const engineA = await bootEngine("A", store, 7411);

  await engineA.handleEvent(commentEvent("300", "first", "wc-1"));
  if (!(await waitFor(noRunningMessages))) throw new Error("first round never settled");

  const uid = await firstSessionUid();
  await store.updateSession(uid, { progressCommentId: backend.progressId });

  backend.plan = plan;
  engineA.destroy();
  await new Promise((r) => setTimeout(r, LEASE_TTL_MS + 150));

  const storeB = new Store();
  const engineB = await bootEngine("B", storeB, 7412);
  await engineB.recover();

  await engineB.handleEvent(commentEvent("300", "second", "wc-2"));
  if (!(await waitFor(noRunningMessages))) throw new Error("second round never settled");
}

describe("terminal marker placement (dog/tasks#18)", () => {
  it("posts the ✅ as a new trailing comment and drops the stale ⏳ when the thread moved past it", async () => {
    await runSecondRound(["progress", "reply"]);

    expect(tracker.deletes).toContain(backend.progressId);
    expect(tracker.creates.some((c) => c.body.includes("✅") && c.body.includes("completed"))).toBe(true);
    expect(tracker.edits.some((e) => e.id === backend.progressId && e.body.includes("completed"))).toBe(false);
  }, 20000);

  it("edits the ⏳ in place when it is still the last comment", async () => {
    await runSecondRound(["reply", "progress"]);

    expect(tracker.edits.some((e) => e.id === backend.progressId && e.body.includes("✅") && e.body.includes("completed"))).toBe(true);
    expect(tracker.deletes).not.toContain(backend.progressId);
    expect(tracker.creates.some((c) => c.body.includes("completed"))).toBe(false);
  }, 20000);
});
