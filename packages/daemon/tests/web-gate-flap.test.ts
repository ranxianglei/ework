import { beforeAll, beforeEach, afterEach, describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
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
  Message,
} from "../src/trackers/types";

// Web-gate flap tolerance (2026-10-30 incident class).
//
// A live web answering with an HTTP error (502/500/...) is an infrastructure
// blip, NOT a policy decision — policy travels in the 200 JSON body. Before
// this fix, one bad response:
//   1. terminated every queued spawn as `failed: gate: web returned NNN`,
//   2. latched the observer's stranded-message safety drain off fleet-wide,
//   3. made restart-recovery DISCARD queued user input.
// Now: HTTP errors are classified `httpError` and get the same backoff-hold
// treatment as network unreachability; nothing is ever terminally lost to a
// gate blip, and the observer drain keeps working while any issue answers.

const FAKE_BIN_OK = join(tmpdir(), "fake-opencode-gateflap-ok.sh"); // exits 0 after a short sleep

let workdirBase: string;
let tracker: RecordingTracker;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

class RecordingTracker implements IssueTracker {
  readonly type = "gitea";
  readonly comments: string[] = [];
  statuses: string[] = [];

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
  async updateStatus(_ref: unknown, status: string): Promise<void> {
    this.statuses.push(status);
  }
  async setCommentModel(): Promise<void> {}
  async setReaction(): Promise<void> {}
  async setIssueReaction(): Promise<void> {}
  getTrackerInstructions(): TrackerInstructions { return { clone: "git clone fake", issueRef: "fake/ref" }; }
  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
  resolveWorkdir(_issue: Issue, _session: OpSession): string {
    return join(workdirBase, String(_issue.trackerIssueId), _session.name);
  }
  async resumeOpenCodeSession(): Promise<string | null> { return null; }
}

const REF: TrackerRef = {
  trackerType: "gitea",
  scope: { owner: "ranxianglei", repo: "billion-context" },
  issueId: "361",
};

const KEY = "gitea:ranxianglei/billion-context#361@ework-daemon";

interface GateResult {
  allowed: boolean;
  reason: string;
  resetMs?: number;
  concurrency?: number | null;
  unreachable?: boolean;
  httpError?: boolean;
}

interface BootOpts {
  gate?: () => Promise<GateResult>;
  work?: Partial<Config["work"]>;
  giteaUrl?: string;
}

async function bootEngine(opts: BootOpts = {}): Promise<{ engine: Engine; store: Store; daemonId: number }> {
  const cfg = loadConfig();
  const full: Config = {
    ...cfg,
    gitea: opts.giteaUrl ? { ...cfg.gitea, url: opts.giteaUrl } : cfg.gitea,
    opencode: { ...cfg.opencode, binary: FAKE_BIN_OK, baseWorkdir: workdirBase },
    daemon: { ...cfg.daemon, wakeLogins: ["dog"], noWakeLogins: [], nonWakingAuthors: [] },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000, infraRetryMax: 1, infraRetryBaseMs: 50, ...(opts.work ?? {}) },
  };
  const store = new Store();
  const daemonId = await store.registerDaemon("host-flap", "127.0.0.1:0", 4, 60_000);
  const engine = new Engine(full, store, trackerRegistry, {
    daemonId,
    gateChecker: opts.gate ?? (async (): Promise<GateResult> => ({ allowed: true, reason: "test", resetMs: 0 })),
  });
  liveEngines.push(engine);
  return { engine, store, daemonId };
}

async function seed(store: Store, daemonId: number): Promise<{ issue: Issue; session: OpSession; msg: Message }> {
  const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
  await store.claimIssue(issue.id, daemonId);
  const session = await store.createSession(issue.id, "ework-daemon");
  const msg = await store.createMessage(session.id, "[SYSTEM FORWARD] gate flap subject");
  return { issue, session, msg };
}

async function eventually(assert: () => void | Promise<void>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await assert(); return; } catch (err) {
      if (Date.now() > deadline) throw err;
      await Bun.sleep(25);
    }
  }
}

type EnginePriv = {
  deactivateIfIdle: (k: string, s: OpSession, i: Issue) => Promise<void>;
  webGateAllows: (issue: Issue) => Promise<GateResult>;
};

beforeAll(async () => {
  writeFileSync(FAKE_BIN_OK, "#!/bin/sh\nsleep 0.1\nexit 0\n");
  chmodSync(FAKE_BIN_OK, 0o755);
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

  workdirBase = mkdtempSync(join(tmpdir(), "ewgateflap-"));
  tracker = new RecordingTracker();
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(tracker.type, tracker);
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
});

describe("web-gate HTTP error classification", () => {
  test("HTTP error response is classified transient (httpError), never a policy block", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Response("boom", { status: 502 }),
    });
    try {
      const { engine } = await bootEngine({ giteaUrl: `http://127.0.0.1:${srv.port}` });
      const res = await (engine as unknown as EnginePriv).webGateAllows({
        trackerScopeKey: "ranxianglei/billion-context",
        trackerIssueId: "361",
      } as unknown as Issue);
      expect(res.allowed).toBe(false);
      expect(res.httpError).toBe(true);
      expect(res.unreachable).toBeUndefined();
      expect(res.reason).toContain("502");
    } finally {
      srv.stop(true);
    }
  });

  test("connection failure stays unreachable; policy deny carries no transient flag", async () => {
    // Dead port (nothing listening): pure network failure → unreachable.
    const dead = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadPort = dead.port;
    dead.stop(true);
    {
      const { engine } = await bootEngine({ giteaUrl: `http://127.0.0.1:${deadPort}` });
      const res = await (engine as unknown as EnginePriv).webGateAllows({
        trackerScopeKey: "ranxianglei/billion-context",
        trackerIssueId: "361",
      } as unknown as Issue);
      expect(res.allowed).toBe(false);
      expect(res.unreachable).toBe(true);
    }
    // Live web saying "dispatch off": policy, not infra.
    const off = Bun.serve({ port: 0, fetch: () => Response.json({ dispatchOff: true }) });
    try {
      const { engine } = await bootEngine({ giteaUrl: `http://127.0.0.1:${off.port}` });
      const res = await (engine as unknown as EnginePriv).webGateAllows({
        trackerScopeKey: "ranxianglei/billion-context",
        trackerIssueId: "361",
      } as unknown as Issue);
      expect(res.allowed).toBe(false);
      expect(res.httpError).toBeUndefined();
      expect(res.unreachable).toBeUndefined();
    } finally {
      off.stop(true);
    }
  });
});

describe("spawn under a flapping web", () => {
  test("httpError gate past the infra budget HOLDS the message pending — it is never terminal-failed", async () => {
    const { engine, store, daemonId } = await bootEngine({
      gate: async () => ({ allowed: false, reason: "web returned 502", httpError: true }),
    });
    const { issue, session, msg } = await seed(store, daemonId);

    // First attempt requeues on the infra budget; the second attempt finds the
    // budget spent and must hold the row in the queue (short backoff), waiting
    // for the observer drain once the web recovers — not fail it.
    await (engine as unknown as { deactivateIfIdle: EnginePriv["deactivateIfIdle"] }).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "pending") throw new Error(`status=${row?.status} error=${row?.error}`);
      if (!row.error?.startsWith("web transient")) throw new Error(`error=${row?.error}`);
    });

    const row = await store.getMessage(msg.id);
    expect(row?.infraAttempts).toBe(1);
    expect(row?.retryAfter instanceof Date && row.retryAfter.getTime() > Date.now()).toBe(true);
    const status = (await engine.getStatus()).runningCount;
    expect(status).toBe(0); // slot released, not leaked
  });
});

describe("manual retry coverage (operator override)", () => {
  test("retryMessage accepts interrupted rows and resets the spent infra budget", async () => {
    const { engine, store, daemonId } = await bootEngine();
    const { issue, session, msg } = await seed(store, daemonId);
    void issue;

    // Simulate a wedged row: interrupted with an exhausted infra budget and a
    // stale backoff hold — exactly what ops needs to unstick by hand.
    await store.updateMessageStatus(msg.id, "interrupted", "issue closed");
    const db = getDB();
    await db.run("UPDATE {{messages}} SET infra_attempts = 3 WHERE uid = ?", [msg.id]);

    const ok = await engine.retryMessage(msg.id);
    expect(ok).toBe(true);

    const row = await store.getMessage(msg.id);
    expect(["pending", "running"].includes(row?.status ?? "")).toBe(true);
    expect(row?.infraAttempts ?? 0).toBe(0);
  });

  test("retryMessage still refuses rows that never needed a retry", async () => {
    const { engine, store, daemonId } = await bootEngine();
    const { session, msg } = await seed(store, daemonId);
    void session;

    const okMissing = await engine.retryMessage("deadbeef-0000-4000-8000-000000000000"); // nonexistent
    expect(okMissing).toBe(false);

    await store.updateMessageStatus(msg.id, "done");
    expect(await engine.retryMessage(msg.id)).toBe(false);
  });
});
