import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../src/op";
import { Engine, releasePrAdmitted, type TakeoverStrategy } from "../src/opencode";
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
  RuntimeSpawnOpts,
  RuntimeHandle,
  RuntimeSpawnCallbacks,
  LastModelResult,
  SessionOutputResult,
} from "../src/runtime/types";

// Release-PR wake carve-out (billion-context#1313/#1427): release workflow
// bots are excluded from waking by design, but their release PR mirrors must
// still auto-trigger the release-audit session. Title-gated to release PRs
// only — an ordinary bot "[PR] fix: …" never wakes anyone.

const HEARTBEAT_MS = 100;
const LEASE_TTL_MS = 500;
const BOT_USER = "ework-daemon";
const RELEASE_BOT = "github-actions[bot]";

let workdirBase: string;
let fakeTracker: FakeTracker;
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

  workdirBase = `${tmpdir()}/ework-daemon-release-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });
  fakeTracker = new FakeTracker();
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
});

class FakeTracker implements IssueTracker {
  readonly type = "gitea";
  comments: TrackerComment[] = [];
  private nextId = 1;

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }
  async createComment(_ref: TrackerRef, body: string): Promise<{ id: string }> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body, author: BOT_USER, createdAt: new Date().toISOString() });
    return { id };
  }
  async editComment(): Promise<void> {}
  async deleteComment(): Promise<void> {}
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

class FakeBackend implements RuntimeBackend {
  readonly name = "fake";
  spawns = 0;

  async spawn(opts: RuntimeSpawnOpts, callbacks: RuntimeSpawnCallbacks): Promise<RuntimeHandle> {
    this.spawns++;
    const proc = Bun.spawn(["sh", "-c", "sleep 0.1"], { stdout: "ignore", stderr: "ignore" });
    setTimeout(() => {
      fakeTracker.comments.push({
        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        body: "[bot] 🏷 release audit done",
        author: BOT_USER,
        createdAt: new Date().toISOString(),
      });
      callbacks.onOutput();
    }, 40);
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

function makeConfig(releaseWake: boolean): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    daemon: { ...cfg.daemon, wakeLogins: ["dog"], wakeKinds: ["human"], releaseWake },
    opencode: { ...cfg.opencode, binary: "fake-opencode", baseWorkdir: workdirBase, dbPath: join(workdirBase, "opencode.db") },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(store: Store, cfg: Config): Promise<Engine> {
  await store.releaseDeadOwners(cfg.work.leaseTtlMs);
  const daemonId = await store.registerDaemon("host-rw", "127.0.0.1:7421", cfg.work.capacity, cfg.work.leaseTtlMs);
  await store.claimAllOwnerless(daemonId);
  const engine = new Engine(cfg, store, new Map<string, IssueTracker>([["gitea", fakeTracker]]), {
    daemonId,
    gateChecker: async () => ({ allowed: true, reason: "test" }),
    takeover: new TestTakeoverStrategy(workdirBase),
    backend: new FakeBackend(),
    recoverOnBoot: false,
  });
  engine.startHeartbeat(cfg.work.heartbeatMs);
  liveEngines.push(engine);
  return engine;
}

function releasePrEvent(title: string): TrackerEvent {
  return {
    type: "issue_opened",
    ref: { trackerType: "gitea", scope: { owner: "ranxianglei", repo: "billion-context" }, issueId: "1427" },
    issue: { title, body: "[system] release", state: "open", author: RELEASE_BOT },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function messageCount(): Promise<number> {
  const db = getDB();
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM {{messages}}`);
  return row?.n ?? 0;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 8000): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() - start >= timeoutMs) break;
    await sleep(50);
  }
  return await fn();
}

describe("release-PR wake (billion-context#1313/#1427)", () => {
  it("releasePrAdmitted matches release-shaped PR mirrors only", () => {
    expect(releasePrAdmitted("[PR] release v0.1.158", true)).toBe(true);
    expect(releasePrAdmitted("[PR] chore: release v1.2.3", true)).toBe(true);
    expect(releasePrAdmitted("[PR] Release v2.0.0-rc.1", true)).toBe(true);
    expect(releasePrAdmitted("[PR] fix: compress success receipt gains remaining tail", true)).toBe(false);
    expect(releasePrAdmitted("release v0.1.158", true)).toBe(false);
    expect(releasePrAdmitted(undefined, true)).toBe(false);
    expect(releasePrAdmitted("[PR] release v0.1.158", false)).toBe(false);
  });

  it("a bot-authored release PR mirror wakes a session even though bots never wake otherwise", async () => {
    const store = new Store();
    const engine = await bootEngine(store, makeConfig(true));
    await engine.handleEvent(releasePrEvent("[PR] release v0.1.158"));
    const n = await waitFor(async () => ((await messageCount()) > 0 ? (await messageCount()) : undefined));
    expect(n).toBeGreaterThan(0);
  });

  it("a bot-authored ordinary PR mirror still never wakes", async () => {
    const store = new Store();
    const engine = await bootEngine(store, makeConfig(true));
    await engine.handleEvent(releasePrEvent("[PR] fix: some ordinary bot PR"));
    await sleep(600);
    expect(await messageCount()).toBe(0);
  });

  it("WORK_RELEASE_WAKE=false restores the pre-carve-out behavior", async () => {
    const store = new Store();
    const engine = await bootEngine(store, makeConfig(false));
    await engine.handleEvent(releasePrEvent("[PR] release v0.1.158"));
    await sleep(600);
    expect(await messageCount()).toBe(0);
  });
});
