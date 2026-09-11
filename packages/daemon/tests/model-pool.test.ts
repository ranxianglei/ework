import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
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

// Model-pool harness. The fake binary records every --model argument it is
// spawned with, one line per invocation, and exits without emitting a [bot]
// reply. With no real opencode.db present the engine's session-output probe
// reports hasOutput:false, which drives the empty-response path — exactly the
// trigger for the pool's circuit-breaker + fallback requeue.

const FAKE_BIN = join(tmpdir(), "fake-opencode-modelpool.sh");
const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;
const PRIMARY = "prov/m-primary";
const FLASH = "prov/m-flash";
const OTHER = "prov/m-other";

let argsFile: string;
let workdirBase: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  writeFileSync(
    FAKE_BIN,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_MODEL_ARGS"
echo '{\\"sessionID\\":\\"fake-mp-$$\\"}'
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

  argsFile = `/tmp/fake-opencode-mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.FAKE_MODEL_ARGS = argsFile;
  workdirBase = `/tmp/ework-daemon-mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  try { rmSync(argsFile); } catch { /* gone */ }
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
  delete process.env.FAKE_MODEL_ARGS;
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
  async setCommentModel(): Promise<void> {}
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

function makeConfig(pool: string[]): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: {
      ...cfg.opencode,
      binary: FAKE_BIN,
      baseWorkdir: workdirBase,
      defaultModel: PRIMARY,
      modelPool: pool,
      modelCooldownMs: 60_000,
    },
    work: { capacity: 4, maxConcurrent: 2, maxConcurrentExplicit: true, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
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

function modelLines(): string[] {
  try {
    return readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function eventually(assert: () => void, timeoutMs = 12_000): Promise<boolean> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      assert();
      return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (lastErr) throw lastErr;
  return false;
}

// ─── Tests ───

describe("model pool", () => {
  it("resolveSpawnModel: picks only healthy members, falls back when all circuits open", async () => {
    const store = new Store();
    const cfg = makeConfig([FLASH, OTHER]);
    const engine = await bootEngine("pure", store, cfg, 3581);
    const resolve = (e: Engine) => (e as unknown as { resolveSpawnModel(o?: string): string }).resolveSpawnModel.bind(e);

    // override wins outright
    expect(resolve(engine)("prov/explicit")).toBe("prov/explicit");

    // both healthy: pick must be a pool member
    const pick = resolve(engine)();
    expect([FLASH, OTHER]).toContain(pick);

    // circuit-open FLASH: only OTHER remains
    (engine as unknown as { modelCircuits: Map<string, number> }).modelCircuits.set(FLASH, Date.now() + 60_000);
    expect(resolve(engine)()).toBe(OTHER);

    // all open: defaultModel anchor
    (engine as unknown as { modelCircuits: Map<string, number> }).modelCircuits.set(OTHER, Date.now() + 60_000);
    expect(resolve(engine)()).toBe(PRIMARY);
  });

  it("applyModelFallback: circuit opens, message requeued, notice posted, guard respected", async () => {
    const store = new Store();
    const cfg = makeConfig([FLASH, OTHER]);
    const engine = await bootEngine("fallback", store, cfg, 3582);

    await engine.handleEvent(openedEvent("901", "fallback flow"));
    await eventually(() => {
      expect(modelLines().length).toBeGreaterThanOrEqual(1);
    });
    const db = getDB();
    const row = await db.get<{ uid: string; status: string }>("SELECT uid, status FROM {{messages}} ORDER BY created_at DESC LIMIT 1");
    expect(row && row.status).toBeTruthy();

    const apply = (e: Engine) =>
      (e as unknown as {
        applyModelFallback(k: string, s: OpSession, i: Issue, m: string, um: string, at: number, t: IssueTracker, r: TrackerRef): Promise<boolean>;
      }).applyModelFallback.bind(e);
    const session = { id: "s1", name: "awork" } as OpSession;
    const issue = {
      id: "i1",
      trackerType: "gitea",
      trackerIssueId: 901,
      trackerScopeKey: "dog/repo",
      trackerScope: { owner: "dog", repo: "repo" },
    } as unknown as Issue;
    const ref = { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId: "901" } as TrackerRef;

    // wrong model (== default): refused
    expect(await apply(engine)("gitea:dog/repo#901@awork", session, issue, row!.uid, PRIMARY, 0, fakeTracker, ref)).toBe(false);
    // already retried once: refused
    expect(await apply(engine)("gitea:dog/repo#901@awork", session, issue, row!.uid, FLASH, 1, fakeTracker, ref)).toBe(false);
    // legit: applied — circuit open, attempts bumped, notice posted
    expect(await apply(engine)("gitea:dog/repo#901@awork", session, issue, row!.uid, FLASH, 0, fakeTracker, ref)).toBe(true);
    const circuits = (engine as unknown as { modelCircuits: Map<string, number> }).modelCircuits;
    expect(circuits.get(FLASH) ?? 0).toBeGreaterThan(Date.now());
    expect(fakeTracker.comments.some((c) => c.body.includes("切换备用模型"))).toBe(true);
    const after = await db.get<{ status: string; attempts: number }>("SELECT status, attempts FROM {{messages}} WHERE uid = ?", [row!.uid]);
    expect(after!.attempts).toBe(1);
    expect(["pending", "running"]).toContain(after!.status);
    // pool resolution now excludes the open member
    const resolve = (e: Engine) => (e as unknown as { resolveSpawnModel(o?: string): string }).resolveSpawnModel.bind(e);
    expect(resolve(engine)()).toBe(OTHER);
  });
});
