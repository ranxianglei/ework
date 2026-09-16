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

// Exit-chain regressions. The fake binary deliberately leaves an orphaned
// background child holding the stderr pipe open after the direct child exits
// (the exact fd topology that used to park execProcess on stderrText forever).

const FAST_BIN = join(tmpdir(), "fake-opencode-exit-fast.sh");
const BLOCK_BIN = join(tmpdir(), "fake-opencode-exit-block.sh");
const ORPHAN_SECS = 12; // > STDERR_DRAIN_MS so the drain timeout path is exercised
const DRAIN_MS = 5000;
const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;

let counterFile: string;
let workdirBase: string;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  // parent exits immediately; orphan keeps stderr open ORPHAN_SECS
  writeFileSync(
    FAST_BIN,
    `#!/bin/sh
echo "x" >> "$FAKE_OPENCODE_COUNTER"
echo '{\\"sessionID\\":\\"fake-exit-$$\\"}'
(sleep ${ORPHAN_SECS}) &
exit 0
`,
  );
  // parent blocks ~3s (spawn window for forceStop), then exits; orphan ditto
  writeFileSync(
    BLOCK_BIN,
    `#!/bin/sh
echo "x" >> "$FAKE_OPENCODE_COUNTER"
echo '{\\"sessionID\\":\\"fake-exit-$$\\"}'
(sleep ${ORPHAN_SECS}) &
sleep 3
exit 0
`,
  );
  chmodSync(FAST_BIN, 0o755);
  chmodSync(BLOCK_BIN, 0o755);
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

  counterFile = `/tmp/fake-opencode-exit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.FAKE_OPENCODE_COUNTER = counterFile;
  workdirBase = `/tmp/ework-daemon-exit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set("gitea", new FakeTracker());
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

class FakeTracker implements IssueTracker {
  readonly type = "gitea";
  async createComment(): Promise<{ id: string }> { return { id: "c1" }; }
  async editComment(): Promise<void> {}
  async deleteComment(): Promise<void> {}
  async listComments(): Promise<TrackerComment[]> {
    return [{ id: "c1", author: "bot", body: "[bot] done", createdAt: new Date().toISOString() }];
  }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setCommentModel(): Promise<void> {}
  async setReaction(): Promise<void> {}
  formatScopeKey(scope: Record<string, string>): string { return `${scope.owner}/${scope.repo}`; }
  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }
  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(author: string): boolean { return author === "bot"; }
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

function makeConfig(binary: string): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary, baseWorkdir: workdirBase },
    work: { capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: true, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(store: Store, cfg: Config): Promise<Engine> {
  await store.releaseDeadOwners(cfg.work.leaseTtlMs);
  const daemonId = await store.registerDaemon("host-exit", "127.0.0.1:7199", cfg.work.capacity, cfg.work.leaseTtlMs);
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

function commentedEvent(issueId: string, body: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title: "t", body: "b", state: "open", author: "tester" },
    comment: { id: "c1", author: "tester", body },
  };
}

function readCounter(): number {
  try {
    return readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function messageStatuses(): Promise<string> {
  const rows = await getDB().all<{ status: string }>("SELECT status FROM {{messages}} ORDER BY id");
  return rows.map((r) => r.status).join(",");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return await predicate();
}

describe("exit chain: stderr drain", () => {
  it("orphaned stderr holder does not park finishRun (bounded drain)", async () => {
    const store = new Store();
    const engine = await bootEngine(store, makeConfig(FAST_BIN));

    await engine.handleEvent(openedEvent("200", "drain test"));
    expect(await waitFor(() => readCounter() === 1, 5000)).toBe(true);

    // parent exits ~instantly; the orphan keeps stderr open for ORPHAN_SECS.
    // finishRun must land within drain window + margin — not ORPHAN_SECS.
    const settled = await waitFor(async () => (await messageStatuses()) !== "running", DRAIN_MS + 4000);
    expect(settled).toBe(true);
    const statuses = await messageStatuses();
    expect(statuses).not.toContain("running");
  }, 30000);

  it("stale stopping flag from a force-stopped run does not suppress the next run's finishRun", async () => {
    const store = new Store();
    const cfg = makeConfig(BLOCK_BIN);
    const engine = await bootEngine(store, cfg);

    await engine.handleEvent(openedEvent("201", "stopping scope test"));
    expect(await waitFor(() => readCounter() === 1, 5000)).toBe(true);

    // force-stop while the direct child is alive; the orphan keeps the old
    // run's stderr open past the drain window
    await engine.forceStop(`gitea:dog/repo#201@${cfg.bot.username}`);

    // second message on the same issue must spawn and finish cleanly
    await engine.handleEvent(commentedEvent("201", "second message"));
    expect(await waitFor(() => readCounter() === 2, 8000)).toBe(true);

    const settled = await waitFor(async () => {
      const s = await messageStatuses();
      return s.split(",").every((x) => x !== "running");
    }, DRAIN_MS + 8000);
    expect(settled).toBe(true);
  }, 45000);
});
