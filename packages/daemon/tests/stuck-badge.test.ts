import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../src/op";
import {
  Engine,
  type TakeoverStrategy,
  evaluateBadgeSignals,
  decideBadgeAction,
  BADGE_RESET_MARKER,
  buildBadgeResetNotice,
} from "../src/opencode";
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
  BadgeEntry,
} from "../src/trackers/types";
import type {
  RuntimeBackend,
  RuntimeHandle,
  RuntimeSpawnOpts,
  RuntimeSpawnCallbacks,
  LastModelResult,
  SessionOutputResult,
} from "../src/runtime/types";

// Stuck-badge sweep harness (ework#12). Models the web side with an in-memory
// badge table + a local mock of GET /api/v1/dispatch-state, then drives the
// engine's sweep both manually and through its real 1-min-class timer.

const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;
const BOT_USER = "ework-daemon";
const HUMAN_USER = "tester";
// Tiny TTLs so every scenario settles in well under the spec's 2-minute bound.
const SWEEP_INTERVAL_MS = 300;
const BADGE_TTL_MS = 500;
const OUTPUT_TTL_MS = 400;
const MODEL_TTL_MS = 400;

interface BadgeRecord { status: string; since: number }
type BadgeTable = Map<string, BadgeRecord>; // key: "owner/repo#number"

let workdirBase: string;
let badgeTable: BadgeTable;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
let mockWeb: MockWeb | null = null;
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

  workdirBase = `${tmpdir()}/ework-daemon-badge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

  badgeTable = new Map<string, BadgeRecord>();
  fakeTracker = new FakeTracker(badgeTable);
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(fakeTracker.type, fakeTracker);
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  mockWeb?.stop();
  mockWeb = null;
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
});

/** Web-side badge table standing in for issues.ai_status (+ai_status_since). */
class FakeTracker implements IssueTracker {
  readonly type = "gitea";
  comments: TrackerComment[] = [];
  statuses: Array<{ key: string; status: string }> = [];
  private nextId = 1;
  constructor(private badges: BadgeTable) {}

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }

  private key(ref: TrackerRef): string {
    return `${ref.scope["owner"]}/${ref.scope["repo"]}#${ref.issueId}`;
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

  async updateStatus(ref: TrackerRef, status: string): Promise<void> {
    const k = this.key(ref);
    this.statuses.push({ key: k, status });
    if (status === "") this.badges.delete(k);
    else this.badges.set(k, { status, since: Date.now() });
  }

  async listBadges(status: string): Promise<BadgeEntry[]> {
    const out: BadgeEntry[] = [];
    for (const [k, rec] of this.badges) {
      if (rec.status !== status) continue;
      const [owner, rest] = k.split("/");
      const [repo, number] = rest!.split("#");
      out.push({ owner: owner!, repo: repo!, number: Number(number), aiStatus: rec.status, since: rec.since });
    }
    return out;
  }

  async setCommentModel(): Promise<void> {}
  async setReaction(): Promise<void> {}

  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }

  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(author: string): boolean { return author === BOT_USER; }
}

/** Minimal mock of the web machine endpoints the sweep depends on. */
class MockWeb {
  private server: ReturnType<typeof Bun.serve>;
  constructor(private badges: BadgeTable) {
    this.server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/dispatch-state") {
          const key = `${url.searchParams.get("owner")}/${url.searchParams.get("repo")}#${url.searchParams.get("number")}`;
          return Response.json({ dispatchOff: false, aiStatus: this.badges.get(key)?.status ?? "" });
        }
        return Response.json({ error: "not found" }, 404);
      },
    });
  }
  get url(): string { return `http://127.0.0.1:${this.server.port}`; }
  stop(): void { this.server.stop(true); }
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
  constructor(private comments: TrackerComment[]) {}

  async spawn(opts: RuntimeSpawnOpts, callbacks: RuntimeSpawnCallbacks): Promise<RuntimeHandle> {
    this.spawns++;
    const proc = Bun.spawn(["sh", "-c", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
    callbacks.onOutput();
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

function makeConfig(webUrl: string): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    gitea: { ...cfg.gitea, url: webUrl },
    opencode: { ...cfg.opencode, binary: "fake-opencode", baseWorkdir: workdirBase, dbPath: join(workdirBase, "opencode.db") },
    work: {
      ...cfg.work,
      capacity: 4,
      maxConcurrent: 4,
      maxConcurrentExplicit: false,
      heartbeatMs: HEARTBEAT_MS,
      leaseTtlMs: LEASE_TTL_MS,
      badgeSweepIntervalMs: SWEEP_INTERVAL_MS,
      badgeTtlMs: BADGE_TTL_MS,
      badgeOutputTtlMs: OUTPUT_TTL_MS,
      badgeModelTtlMs: MODEL_TTL_MS,
    },
  };
}

async function bootEngine(name: string, store: Store, cfg: Config, port: number, backend: FakeBackend, badgeSweep = false): Promise<{ engine: Engine; daemonId: number }> {
  await store.releaseDeadOwners(cfg.work.leaseTtlMs);
  const daemonId = await store.registerDaemon(`host-${name}`, `127.0.0.1:${port}`, cfg.work.capacity, cfg.work.leaseTtlMs);
  await store.claimAllOwnerless(daemonId);
  const engine = new Engine(cfg, store, trackerRegistry, {
    daemonId,
    gateChecker: async () => ({ allowed: true, reason: "test" }),
    takeover: new TestTakeoverStrategy(workdirBase),
    backend,
    recoverOnBoot: false,
    badgeSweep,
  });
  engine.startHeartbeat(cfg.work.heartbeatMs);
  liveEngines.push(engine);
  return { engine, daemonId };
}

function commentEvent(issueId: string, body: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title: "stuck badge test", body: "b", state: "open", author: HUMAN_USER },
    comment: { id: `wc-${Date.now()}`, body, author: HUMAN_USER },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() - start >= timeoutMs) break;
    await sleep(50);
  }
  return await fn();
}

async function messageRows(): Promise<Array<{ status: string }>> {
  const db = getDB();
  return db.all<{ status: string }>(`SELECT status FROM {{messages}} ORDER BY created_at ASC`);
}

function badgeKey(issueId: string): string { return `dog/repo#${issueId}`; }

/** Age a badge past its TTL as if the process that wrote it vanished. */
function ageBadge(issueId: string): void {
  const rec = badgeTable.get(badgeKey(issueId));
  if (rec) rec.since = Date.now() - BADGE_TTL_MS * 2;
}

async function getRunningPid(): Promise<number | null> {
  const db = getDB();
  const row = await db.get<{ opencode_pid: number | null }>(`SELECT opencode_pid FROM {{op_sessions}} LIMIT 1`);
  return row?.opencode_pid ?? null;
}

describe("badge signal helpers (unit)", () => {
  it("evaluateBadgeSignals: dead pid + no output + no model → stuck", () => {
    const v = evaluateBadgeSignals({ pidAlive: false, outputAgeMs: 999_999, modelAgeMs: null }, { outputTtlMs: OUTPUT_TTL_MS, modelTtlMs: MODEL_TTL_MS }, false);
    expect(v.alive).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(["pid-dead", "no-recent-output", "no-recent-model"]));
  });

  it("evaluateBadgeSignals: live pid alone keeps the badge", () => {
    const v = evaluateBadgeSignals({ pidAlive: true, outputAgeMs: null, modelAgeMs: null }, { outputTtlMs: OUTPUT_TTL_MS, modelTtlMs: MODEL_TTL_MS }, false);
    expect(v.alive).toBe(true);
  });

  it("evaluateBadgeSignals: fresh output alone keeps the badge", () => {
    const v = evaluateBadgeSignals({ pidAlive: false, outputAgeMs: 1000, modelAgeMs: null }, { outputTtlMs: OUTPUT_TTL_MS * 10, modelTtlMs: MODEL_TTL_MS }, false);
    expect(v.alive).toBe(true);
  });

  it("evaluateBadgeSignals: expired heartbeat forces stale even with a live pid", () => {
    const v = evaluateBadgeSignals({ pidAlive: true, outputAgeMs: 1000, modelAgeMs: 1000 }, { outputTtlMs: OUTPUT_TTL_MS * 10, modelTtlMs: MODEL_TTL_MS * 10 }, true);
    expect(v.alive).toBe(false);
    expect(v.reasons).toContain("heartbeat-expired");
  });

  it("decideBadgeAction: young badge gets grace; stale decides by delivery", () => {
    expect(decideBadgeAction(BADGE_TTL_MS / 2, BADGE_TTL_MS, false)).toBe("grace");
    expect(decideBadgeAction(BADGE_TTL_MS * 2, BADGE_TTL_MS, true)).toBe("complete");
    expect(decideBadgeAction(BADGE_TTL_MS * 2, BADGE_TTL_MS, false)).toBe("reset");
    // Unknown since → never grace (safe direction: arbitrate).
    expect(decideBadgeAction(null, BADGE_TTL_MS, false)).toBe("reset");
  });

  it("reset notice carries the dedup marker", () => {
    expect(buildBadgeResetNotice()).toContain(BADGE_RESET_MARKER);
    expect(buildBadgeResetNotice().startsWith("[system]")).toBe(true);
  });
});

describe("stuck-badge sweep (integration)", () => {
  it("flips a dead-and-record-wiped processing badge to idle + [system] notice (acceptance)", async () => {
    mockWeb = new MockWeb(badgeTable);
    const store = new Store();
    const cfg = makeConfig(mockWeb.url);
    const backend = new FakeBackend(fakeTracker.comments);
    const { engine: engineA } = await bootEngine("A", store, cfg, 7421, backend);

    await engineA.handleEvent(commentEvent("911", "please fix"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);
    expect(badgeTable.get(badgeKey("911"))?.status).toBe("processing");

    // Hard crash mid-run (kills the child), then wipe the engine's records.
    engineA.destroy();
    await sleep(LEASE_TTL_MS + 150);
    const db = getDB();
    await db.exec(`DELETE FROM {{op_sessions}}`);
    ageBadge("911");

    const { engine: engineB } = await bootEngine("B", store, cfg, 7422, backend);
    await engineB.sweepStuckBadges();

    const flips = fakeTracker.statuses.filter((s) => s.key === badgeKey("911"));
    expect(flips.some((s) => s.status === "")).toBe(true);
    expect(flips.some((s) => s.status === "completed")).toBe(false);
    const notices = fakeTracker.comments.filter((c) => c.body.includes(BADGE_RESET_MARKER));
    expect(notices.length).toBe(1);
    // Idempotent: a second sweep must not re-notify (badge already gone).
    await engineB.sweepStuckBadges();
    expect(fakeTracker.comments.filter((c) => c.body.includes(BADGE_RESET_MARKER)).length).toBe(1);
  });

  it("keeps a badge whose session process is genuinely alive", async () => {
    mockWeb = new MockWeb(badgeTable);
    const store = new Store();
    const cfg = makeConfig(mockWeb.url);
    const backend = new FakeBackend(fakeTracker.comments);
    const { engine } = await bootEngine("A", store, cfg, 7423, backend);

    await engine.handleEvent(commentEvent("912", "please fix"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);
    ageBadge("912"); // badge is old, but the child is still sleeping

    await engine.sweepStuckBadges();

    const flips = fakeTracker.statuses.filter((s) => s.key === badgeKey("912"));
    expect(flips.every((s) => s.status === "processing")).toBe(true);
    expect(fakeTracker.comments.some((c) => c.body.includes(BADGE_RESET_MARKER))).toBe(false);
    // Live sessions get their heartbeat refreshed, not clobbered.
    const hb = await getDB().get<{ expected_heartbeat_at: number | null }>(`SELECT expected_heartbeat_at FROM {{op_sessions}} LIMIT 1`);
    expect(hb?.expected_heartbeat_at ?? 0).toBeGreaterThan(Date.now());
  });

  it("completes an orphan badge when the comment stream shows a bot delivery", async () => {
    mockWeb = new MockWeb(badgeTable);
    const store = new Store();
    const cfg = makeConfig(mockWeb.url);
    const backend = new FakeBackend(fakeTracker.comments);
    const { engine } = await bootEngine("A", store, cfg, 7424, backend);

    // Pure orphan: the engine has NO issue/session/message rows for this badge.
    badgeTable.set(badgeKey("913"), { status: "processing", since: Date.now() - BADGE_TTL_MS * 2 });
    fakeTracker.comments.push({
      id: "bot-delivery-913",
      body: "[bot] 🏷 已完成，修复提交在 PR #12，测试全部通过。",
      author: BOT_USER,
      createdAt: new Date(Date.now() - BADGE_TTL_MS).toISOString(),
    });

    await engine.sweepStuckBadges();

    const flips = fakeTracker.statuses.filter((s) => s.key === badgeKey("913"));
    expect(flips.some((s) => s.status === "completed")).toBe(true);
    expect(fakeTracker.comments.some((c) => c.body.includes(BADGE_RESET_MARKER))).toBe(false);
  });

  it("resets an orphan badge without any delivery and notifies once", async () => {
    mockWeb = new MockWeb(badgeTable);
    const store = new Store();
    const cfg = makeConfig(mockWeb.url);
    const backend = new FakeBackend(fakeTracker.comments);
    const { engine } = await bootEngine("A", store, cfg, 7425, backend);

    badgeTable.set(badgeKey("914"), { status: "processing", since: Date.now() - BADGE_TTL_MS * 2 });
    fakeTracker.comments.push({ id: "human-914", body: "hello?", author: HUMAN_USER, createdAt: new Date().toISOString() });

    await engine.sweepStuckBadges();

    const flips = fakeTracker.statuses.filter((s) => s.key === badgeKey("914"));
    expect(flips.some((s) => s.status === "")).toBe(true);
    expect(fakeTracker.comments.filter((c) => c.body.includes(BADGE_RESET_MARKER)).length).toBe(1);
  });

  it("skips badges owned by another live daemon", async () => {
    mockWeb = new MockWeb(badgeTable);
    const store = new Store();
    const cfg = makeConfig(mockWeb.url);
    const backend = new FakeBackend(fakeTracker.comments);
    const { engine } = await bootEngine("A", store, cfg, 7426, backend);

    await engine.handleEvent(commentEvent("915", "please fix"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);

    // Pretend a different (live, registered) daemon owns this issue.
    const otherDaemon = await store.registerDaemon("host-other", "127.0.0.1:7499", 1, cfg.work.leaseTtlMs);
    await getDB().run(`UPDATE {{issues}} SET owner_daemon_id = ? WHERE tracker_issue_id = '915'`, [otherDaemon]);
    ageBadge("915");

    await engine.sweepStuckBadges();

    const flips = fakeTracker.statuses.filter((s) => s.key === badgeKey("915"));
    expect(flips.every((s) => s.status === "processing")).toBe(true);
    const state = engine.getBadgeSweepState();
    const entry = state.entries.find((e) => e.number === 915);
    expect(entry?.verdict).toBe("skipped");
  });

  it("auto-flips within the timer loop without manual driving (spec: < 2 min)", async () => {
    mockWeb = new MockWeb(badgeTable);
    const store = new Store();
    const cfg = makeConfig(mockWeb.url);
    const backend = new FakeBackend(fakeTracker.comments);
    const { engine: engineA } = await bootEngine("A", store, cfg, 7427, backend, true);

    await engineA.handleEvent(commentEvent("916", "please fix"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);

    // Crash + record wipe, exactly like the weekly recurrence class.
    engineA.destroy();
    await sleep(LEASE_TTL_MS + 150);
    await getDB().exec(`DELETE FROM {{op_sessions}}`);
    ageBadge("916");

    const { engine: engineB } = await bootEngine("B", store, cfg, 7428, backend, true);
    const started = Date.now();
    const flipped = await waitFor(() =>
      fakeTracker.statuses.some((s) => s.key === badgeKey("916") && s.status === "") ? true : undefined,
    );
    expect(flipped).toBe(true);
    expect(Date.now() - started).toBeLessThan(2 * 60_000);
    void engineB;
  });
});
