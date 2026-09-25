import { beforeAll, beforeEach, afterEach, describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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

// Infra-class failures (web unreachable / ENOSPC / child killed by signal)
// must retry on a dedicated budget with exponential backoff and must NOT
// consume the content-failure budget — until the infra budget is exhausted,
// only then does the message go terminal failed (ework#5 spec items 2+3).

const FAKE_BIN_KILL = join(tmpdir(), "fake-opencode-infra-kill.sh"); // SIGKILLs itself -> exit 137
const FAKE_BIN_OK = join(tmpdir(), "fake-opencode-infra-ok.sh"); // exits 0 after a short sleep
const FAKE_BIN_EXIT1 = join(tmpdir(), "fake-opencode-infra-exit1.sh"); // exits 1 instantly -> startup crash

let workdirBase: string;
let flakyBin: string; // fails once with SIGKILL, then exits 0 (counter-file driven)
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
  getTrackerInstructions(): TrackerInstructions { return { clone: "git clone fake", issueRef: "fake/ref" }; }
  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
  resolveWorkdir(_issue: Issue, _session: OpSession): string {
    return join(workdirBase, String(_issue.trackerIssueId), _session.name);
  }
  async resumeOpenCodeSession(): Promise<string | null> { return null; }
}

interface BootOpts {
  gate?: () => Promise<{ allowed: boolean; reason: string; unreachable?: boolean }>;
  bin?: string;
  work?: Partial<Config["work"]>;
}

async function bootEngine(opts: BootOpts = {}): Promise<{ engine: Engine; store: Store; daemonId: number }> {
  const cfg = loadConfig();
  const full: Config = {
    ...cfg,
    opencode: { ...cfg.opencode, binary: opts.bin ?? FAKE_BIN_OK, baseWorkdir: workdirBase },
    daemon: { ...cfg.daemon, wakeLogins: ["dog"], noWakeLogins: [], nonWakingAuthors: [] },
    // Tiny backoff so the whole retry ladder runs in well under a second.
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000, infraRetryMax: 3, infraRetryBaseMs: 50, ...(opts.work ?? {}) },
  };
  const store = new Store();
  const daemonId = await store.registerDaemon("host-infra", "127.0.0.1:0", 4, 60_000);
  const engine = new Engine(full, store, trackerRegistry, {
    daemonId,
    gateChecker: opts.gate ?? (async () => ({ allowed: true, reason: "test", resetMs: 0 })),
  });
  liveEngines.push(engine);
  return { engine, store, daemonId };
}

const REF: TrackerRef = {
  trackerType: "gitea",
  scope: { owner: "ranxianglei", repo: "billion-context" },
  issueId: "361",
};

const KEY = "gitea:ranxianglei/billion-context#361@ework-daemon";

async function seed(store: Store, daemonId: number): Promise<{ issue: Issue; session: OpSession; msg: Message }> {
  const issue = await store.findOrCreateIssue(REF, "ranxianglei/billion-context", "t");
  await store.claimIssue(issue.id, daemonId);
  const session = await store.createSession(issue.id, "ework-daemon");
  const msg = await store.createMessage(session.id, "[SYSTEM FORWARD] infra retry subject");
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
  recover: () => Promise<void>;
};

beforeAll(async () => {
  writeFileSync(FAKE_BIN_KILL, "#!/bin/sh\nkill -9 $$\n");
  chmodSync(FAKE_BIN_KILL, 0o755);
  writeFileSync(FAKE_BIN_EXIT1, "#!/bin/sh\nexit 1\n");
  chmodSync(FAKE_BIN_EXIT1, 0o755);
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

  workdirBase = mkdtempSync(join(tmpdir(), "ewinfra-"));
  flakyBin = join(workdirBase, "fake-opencode-flaky.sh");
  const counterFile = join(workdirBase, "flaky-count");
  writeFileSync(flakyBin, [
    "#!/bin/sh",
    `n=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
    "n=$((n+1))",
    `echo "$n" > "${counterFile}"`,
    'if [ "$n" -lt 2 ]; then kill -9 $$; fi',
    "sleep 0.1",
    "exit 0",
  ].join("\n"));
  chmodSync(flakyBin, 0o755);

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

describe("infra failure auto-retry (ework#5)", () => {
  test("N consecutive infra failures end terminal failed only after the budget is exhausted", async () => {
    const { engine, store, daemonId } = await bootEngine({ bin: FAKE_BIN_KILL, work: { infraRetryMax: 2, infraRetryBaseMs: 50 } });
    const { issue, session, msg } = await seed(store, daemonId);

    await (engine as unknown as EnginePriv).deactivateIfIdle(KEY, session, issue);

    // Mid-flight: the message is requeued pending on the INFRA budget while the
    // content-failure attempt counter stays untouched.
    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "pending") throw new Error(`status=${row?.status}`);
      if (!row.error?.includes("auto-retry")) throw new Error(`error=${row?.error}`);
      if (row.attempts !== 0) throw new Error(`content attempts consumed: ${row.attempts}`);
    });

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "failed") throw new Error(`status=${row?.status} error=${row?.error}`);
      if (!row.error?.startsWith("exit 137:")) throw new Error(`error=${row?.error}`);
    });

    const final = await store.getMessage(msg.id);
    expect(final?.infraAttempts).toBe(2); // full infra budget consumed
    expect(final?.attempts).toBe(1); // only the terminal failure counts as a content attempt
    expect((await engine.getStatus()).runningCount).toBe(0);
    expect((await store.getSession(session.id))?.state).toBe("idle");
  });

  test("an infra failure followed by a healthy run completes the message", async () => {
    const { engine, store, daemonId } = await bootEngine({ bin: flakyBin, work: { infraRetryMax: 3, infraRetryBaseMs: 50 } });
    const { issue, session, msg } = await seed(store, daemonId);

    await (engine as unknown as EnginePriv).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "done") throw new Error(`status=${row?.status} error=${row?.error}`);
    });

    const row = await store.getMessage(msg.id);
    expect(row?.infraAttempts).toBe(1);
    expect(row?.attempts).toBe(0); // never touched by the infra path
    // The first requeue posts a visible notice to the issue thread.
    expect(tracker.comments.some((c) => c.includes("infrastructure failure"))).toBe(true);
  });

  // billion-context-pi#531: the opencode DB failed `PRAGMA journal_mode = WAL`
  // right after an OOM restart and the spawn died in ~1s with exit 1 — the
  // work item was consumed as terminal with no retry. A fast crash never
  // reached the model, so it must ride the infra budget instead.
  test("a startup crash (instant exit 1) retries on the infra budget and completes when the environment recovers", async () => {
    const startupFlakyBin = join(workdirBase, "fake-opencode-startup-flaky.sh");
    const counterFile = join(workdirBase, "startup-count");
    writeFileSync(startupFlakyBin, [
      "#!/bin/sh",
      `n=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
      "n=$((n+1))",
      `echo "$n" > "${counterFile}"`,
      'if [ "$n" -lt 2 ]; then exit 1; fi',
      "sleep 0.1",
      "exit 0",
    ].join("\n"));
    chmodSync(startupFlakyBin, 0o755);

    const { engine, store, daemonId } = await bootEngine({ bin: startupFlakyBin, work: { infraRetryMax: 3, infraRetryBaseMs: 50 } });
    const { issue, session, msg } = await seed(store, daemonId);

    await (engine as unknown as EnginePriv).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "done") throw new Error(`status=${row?.status} error=${row?.error}`);
    });

    const row = await store.getMessage(msg.id);
    expect(row?.infraAttempts).toBe(1);
    expect(row?.attempts).toBe(0);
  });

  test("persistent startup crashes end terminal failed only after the infra budget", async () => {
    const { engine, store, daemonId } = await bootEngine({ bin: FAKE_BIN_EXIT1, work: { infraRetryMax: 2, infraRetryBaseMs: 50 } });
    const { issue, session, msg } = await seed(store, daemonId);

    await (engine as unknown as EnginePriv).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "failed") throw new Error(`status=${row?.status}`);
    });

    const row = await store.getMessage(msg.id);
    expect(row?.error).toMatch(/^exit 1:/);
    expect(row?.infraAttempts).toBe(2);
    expect((await engine.getStatus()).runningCount).toBe(0);
  });

  test("infraRetryMax=0 disables auto-retry: immediate terminal failure", async () => {
    const { engine, store, daemonId } = await bootEngine({ bin: FAKE_BIN_KILL, work: { infraRetryMax: 0, infraRetryBaseMs: 50 } });
    const { issue, session, msg } = await seed(store, daemonId);

    await (engine as unknown as EnginePriv).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "failed") throw new Error(`status=${row?.status}`);
    });

    const row = await store.getMessage(msg.id);
    expect(row?.error).toMatch(/^exit 137:/);
    expect(row?.infraAttempts).toBe(0);
  });

  test("web-unreachable gate requeues with backoff and only fails after the budget", async () => {
    const { engine, store, daemonId } = await bootEngine({
      bin: FAKE_BIN_OK,
      work: { infraRetryMax: 2, infraRetryBaseMs: 50 },
      gate: async () => ({ allowed: false, reason: "web unreachable: Unable to connect", unreachable: true }),
    });
    const { issue, session, msg } = await seed(store, daemonId);

    // Drive the run directly: recover() short-circuits on an unreachable web
    // by design (boot-race tolerance), so the gate-branch requeue only runs
    // for sessions whose run starts while the web is down mid-flight.
    await (engine as unknown as EnginePriv).deactivateIfIdle(KEY, session, issue);

    await eventually(async () => {
      const row = await store.getMessage(msg.id);
      if (row?.status !== "failed") throw new Error(`status=${row?.status} error=${row?.error}`);
      if (!row.error?.startsWith("gate: web unreachable")) throw new Error(`error=${row?.error}`);
    });

    const row = await store.getMessage(msg.id);
    expect(row?.infraAttempts).toBe(2);
    expect(tracker.comments.some((c) => c.includes("infrastructure failure"))).toBe(true);
  });
});
