import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync } from "fs";
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

// Concurrency limiting harness. Verifies that maxConcurrent slots are
// respected: when the limit is reached, new messages are queued (pending
// in DB) rather than spawning additional processes. When a slot frees,
// drainGlobalPending picks up the next queued message.
//
// Uses a fake binary that BLOCKS for a fixed duration before exiting,
// so the engine's running.size stays > 0 while we dispatch a 2nd message.

const FAKE_BIN = join(tmpdir(), "fake-opencode-concurrency.sh");
const BLOCK_MS = 600;
const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;

let counterFile: string;
let workdirBase: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  writeFileSync(
    FAKE_BIN,
    `#!/bin/sh
echo "1" >> "$FAKE_OPENCODE_COUNTER"
echo '{\\"sessionID\\":\\"fake-conc-$$\\"}'
sleep ${BLOCK_MS / 1000}
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

  counterFile = `/tmp/fake-opencode-conc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.FAKE_OPENCODE_COUNTER = counterFile;
  workdirBase = `/tmp/ework-daemon-conc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

  fakeTracker = new FakeTracker();
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(fakeTracker.type, fakeTracker);
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  try { rmSync(counterFile); } catch { /* gone */ }
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
  delete process.env.FAKE_OPENCODE_COUNTER;
});

// ─── Stubs ───

class FakeTracker implements IssueTracker {
  readonly type = "gitea";
  comments: TrackerComment[] = [];
  private nextId = 1;

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }

  async createComment(_ref: TrackerRef, body: string): Promise<{ id: string }> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body, author: "system", createdAt: new Date().toISOString() });
    return { id };
  }

  async editComment(): Promise<void> {}
  async deleteComment(): Promise<void> {}
  async listComments(): Promise<TrackerComment[]> { return [...this.comments]; }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setCommentModel(_ref: unknown, _commentId: string, _model: string): Promise<void> {}
  async setReaction(): Promise<void> {}

  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }

  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
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

function makeConfig(maxConcurrent: number): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase },
    work: { capacity: 4, maxConcurrent, maxConcurrentExplicit: true, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(name: string, store: Store, cfg: Config, port: number): Promise<Engine> {
  await store.releaseDeadOwners(cfg.work.leaseTtlMs);
  const daemonId = await store.registerDaemon(
    `host-${name}`,
    `127.0.0.1:${port}`,
    cfg.work.capacity,
    cfg.work.leaseTtlMs,
  );
  await store.claimAllOwnerless(daemonId);
  const engine = new Engine(cfg, store, trackerRegistry, {
    daemonId, gateChecker: async () => ({ allowed: true, reason: "test" }),
    takeover: new TestTakeoverStrategy(workdirBase),
  });
  engine.startHeartbeat(cfg.work.heartbeatMs);
  liveEngines.push(engine);
  return engine;
}

function openedEvent(issueId: string, title: string): TrackerEvent {
  return {
    type: "issue_opened",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title, body: "test body", state: "open", author: "tester" },
  };
}

function readCounter(): number {
  try {
    return readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

// ─── Tests ───

describe("concurrency: maxConcurrent limiting", () => {
  it("with maxConcurrent=1, 2nd concurrent message is queued (not spawned)", async () => {
    const store = new Store();
    const cfg = makeConfig(1);
    const engine = await bootEngine("A", store, cfg, 7101);

    // Dispatch first issue → spawns process (blocks for BLOCK_MS)
    await engine.handleEvent(openedEvent("100", "issue 1"));
    // Wait for first spawn to register
    await waitFor(() => readCounter() === 1, 3000);
    expect(readCounter()).toBe(1);

    // Dispatch second issue WHILE first is still running
    await engine.handleEvent(openedEvent("200", "issue 2"));

    // Wait a bit to see if a 2nd spawn sneaks in (it shouldn't)
    await new Promise((r) => setTimeout(r, 200));
    expect(readCounter()).toBe(1); // Still only 1 spawn!

    // Wait for first process to finish + drain picks up the 2nd
    await waitFor(() => readCounter() === 2, 5000);
    expect(readCounter()).toBe(2); // 2nd message drained and spawned
  });

  it("with maxConcurrent=2, two messages spawn concurrently", async () => {
    const store = new Store();
    const cfg = makeConfig(2);
    const engine = await bootEngine("B", store, cfg, 7102);

    // Dispatch both issues
    await engine.handleEvent(openedEvent("300", "issue A"));
    await engine.handleEvent(openedEvent("400", "issue B"));

    // Both should spawn immediately (limit is 2)
    await waitFor(() => readCounter() === 2, 3000);
    expect(readCounter()).toBe(2);

    // Wait for both to finish
    await waitFor(() => readCounter() === 4, 8000); // 2 initial + 2 nudges (MAX_NUDGE_ROUNDS=1)
  });
});
