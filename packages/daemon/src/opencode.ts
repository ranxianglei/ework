import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, existsSync, readFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { homedir } from "os";
import { log } from "./logger";
import type { Config } from "./config";
import type { Store } from "./op";
import type { IssueTracker, TrackerRef, TrackerEvent, TrackerComment, Issue, OpSession, Message } from "./trackers/types";
import { formatKey, parseKey } from "./trackers/types";
import type { RuntimeBackend, RuntimeHandle } from "./runtime/types";
import { OpencodeBackend } from "./runtime/opencode-backend";
import { PiBackend } from "./runtime/pi-backend";

// ─── Types ───

interface TrackerRegistry {
  get(type: string): IssueTracker | undefined;
}

/**
 * Pluggable strategy for taking over a session's workdir + opencode session.
 * Phase 1 ships only RecloneStrategy (fresh clone + fresh opencode session).
 * Phase 2 swaps in NAS-backed / OpenCode-server strategies without touching
 * the coordination layer.
 */
export interface TakeoverStrategy {
  acquireWorkdir(session: OpSession, issue: Issue, cloneUrl?: string, env?: Record<string, string>): Promise<string>;
  resumeOpenCodeSession(session: OpSession): Promise<string | null>;
}

export interface GroupConfig {
  workdirTemplate?: string;
  initScript?: string;
  destroyScript?: string;
  envInitScript?: string;
}

/** Substitute {owner}/{repo}/{issue}/{session} in a workdir template. */
export function resolveTemplatedWorkdir(
  template: string,
  issue: { trackerScopeKey: string; trackerScope: Record<string, unknown>; trackerIssueId: string | number },
  session: { name: string },
  baseWorkdir?: string,
): string {
  const parts = issue.trackerScopeKey.split("/");
  const owner = (issue.trackerScope["owner"] as string) || parts[0] || "default";
  const repo = (issue.trackerScope["repo"] as string) || parts[parts.length - 1] || "default";
  // Use replacer functions to avoid `$&`/`$1` interpretation in replacement strings.
  let dir = template
    .replace(/\{owner\}/g, () => String(owner))
    .replace(/\{repo\}/g, () => String(repo))
    .replace(/\{issue\}/g, () => String(issue.trackerIssueId))
    .replace(/\{session\}/g, () => session.name);
  if (dir.startsWith("~")) {
    dir = join(homedir(), dir.slice(1));
  } else if (!isAbsolute(dir) && baseWorkdir) {
    dir = resolve(baseWorkdir, dir);
  }
  return dir;
}

/** Run a lifecycle script via `bash -c` with cwd=workdir. Uses async Bun.spawn
 *  (not spawnSync) so the event loop is not blocked. A 60s hard timeout kills
 *  hung scripts. Failures are logged and swallowed — never throws — so a broken
 *  init/destroy never blocks the opencode task flow. */
const HOOK_SCRIPT_TIMEOUT_MS = 60_000;
export async function runHookScript(script: string | undefined, workdir: string, label: string, env: Record<string, string> = {}, timeoutMs?: number): Promise<void> {
  if (!script || !script.trim()) return;
  const effectiveTimeout = timeoutMs ?? HOOK_SCRIPT_TIMEOUT_MS;
  try {
    mkdirSync(workdir, { recursive: true });
    const proc = Bun.spawn({
      cmd: ["bash", "-c", script],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, effectiveTimeout);
    try {
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      if (exitCode !== 0) {
        log.warn(`engine: ${label} exited ${exitCode}: ${stderr.slice(0, 500)}`);
      } else if (stderr) {
        log.info(`engine: ${label} stderr: ${stderr.slice(0, 300)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    log.warn(`engine: ${label} failed: ${(e as Error).message}`);
  }
}

const SYSTEM_PREFIX = "[system]";
const RECENT_BOT_REPLY_THRESHOLD_MS = 5 * 60_000; // 5 minutes

/**
 * Determine whether any non-system bot reply exists that is causally after
 * `promptTime` (when provided) or within a 5-minute absolute window (fallback).
 * Exported for unit testing — the causal vs absolute distinction is the P0
 * correctness fix for preempt/nudge false-done detection.
 */
export function hasRecentBotReply(
  comments: TrackerComment[],
  isBotUser: (author: string) => boolean,
  promptTime?: number,
): boolean {
  if (promptTime) {
    return comments.some(c => {
      if (!isBotUser(c.author) || c.body.startsWith(SYSTEM_PREFIX)) return false;
      if (!c.createdAt) return false;
      return new Date(c.createdAt).getTime() > promptTime;
    });
  }
  const now = Date.now();
  return comments.some(c => {
    if (!isBotUser(c.author) || c.body.startsWith(SYSTEM_PREFIX)) return false;
    if (!c.createdAt) return true;
    const age = now - new Date(c.createdAt).getTime();
    return age < RECENT_BOT_REPLY_THRESHOLD_MS;
  });
}

/**
 * Query the opencode SQLite DB for a session's assistant-message output tokens.
 * Returns `{hasOutput: true}` (safe default) when the DB can't be opened or
 * the session is undefined — this means the retry path is only triggered when
 * we have POSITIVE evidence of 0-token output.
 * Exported for unit testing.
 */
export async function checkSessionOutput(
  dbPath: string,
  opencodeSessionId: string | undefined,
): Promise<{ hasOutput: boolean; tokenCount: number }> {
  if (!opencodeSessionId) return { hasOutput: true, tokenCount: 0 };
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return { hasOutput: true, tokenCount: 0 };
  }
  try {
    const row = db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(data,'$.tokens.output') AS INT)), 0) AS tokens " +
      "FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'assistant'"
    ).get(opencodeSessionId) as { n: number; tokens: number } | null;
    if (!row) return { hasOutput: true, tokenCount: 0 };
    return { hasOutput: row.n > 0 && row.tokens > 0, tokenCount: row.tokens };
  } catch {
    return { hasOutput: true, tokenCount: 0 };
  } finally {
    db.close();
  }
}

export async function opencodeSessionExists(dbPath: string, sessionId: string): Promise<boolean> {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return false;
  }
  try {
    const row = db.prepare("SELECT 1 FROM session WHERE id = ? LIMIT 1").get(sessionId);
    return !!row;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Default TakeoverStrategy: deterministic per-issue workdir under
 * `<baseWorkdir>/<owner>--<repo>/<issueId>/<sessionName>`, with a best-effort
 * `git clone` when the directory is empty. Resume always returns null
 * (fresh opencode session — accepts memory loss on takeover).
 */
export class RecloneStrategy implements TakeoverStrategy {
  constructor(private cfg: Config) {}

  async acquireWorkdir(session: OpSession, issue: Issue, cloneUrl?: string, env?: Record<string, string>): Promise<string> {
    if (session.workdir) {
      let dir = session.workdir;
      if (dir.startsWith("~")) dir = join(homedir(), dir.slice(1));
      dir = isAbsolute(dir) ? dir : resolve(this.cfg.opencode.baseWorkdir, dir);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    const parts = issue.trackerScopeKey.split("/");
    const owner = issue.trackerScope["owner"] ?? parts[0] ?? "default";
    const repo = issue.trackerScope["repo"] ?? parts[parts.length - 1] ?? "default";
    const dir = join(
      this.cfg.opencode.baseWorkdir,
      `${owner}--${repo}`,
      String(issue.trackerIssueId),
      session.name,
    );
    mkdirSync(dir, { recursive: true });
    try {
      const entries = readdirSync(dir);
      if (entries.length === 0) {
        const url = cloneUrl ?? `${this.cfg.gitea.url.replace(/\/$/, "")}/${owner}/${repo}.git`;
        const credHelper = process.env.WORK_GIT_CREDENTIAL_HELPER;
        const gitArgs = ["git"];
        if (credHelper) gitArgs.push("-c", `credential.helper=${credHelper}`);
        gitArgs.push("clone", url, dir);
        // ssh without these can sleep forever: no TCP keepalive on a blackholed
        // connection, and host-key/passphrase prompts block a headless daemon.
        const sshCmd = process.env.WORK_GIT_SSH_COMMAND
          ?? "ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o BatchMode=yes";
        let r: { exitCode: number | null; stderr?: Uint8Array | undefined };
        try {
          // async spawn: a slow/hung remote must never block the daemon event
          // loop — spawnSync froze healthz+heartbeats for the whole clone
          // duration. Capped at 10 minutes.
          const proc = Bun.spawn({
            cmd: gitArgs, stdout: "ignore", stderr: "pipe",
            env: { ...process.env, ...env, GIT_SSH_COMMAND: sshCmd },
          });
          const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 10 * 60_000);
          const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).arrayBuffer()]);
          clearTimeout(killTimer);
          r = { exitCode, stderr: new Uint8Array(stderr) };
        } catch {
          r = { exitCode: -1 };
        }
        const exitCode = r.exitCode ?? -1;
        if (exitCode !== 0) {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          if (existsSync(dir) && readdirSync(dir).length === 0) {
            Bun.spawnSync({ cmd: ["git", "init", dir], stdout: "ignore", stderr: "ignore" });
          }
          const stderrBuf = r.stderr as Uint8Array | undefined;
          const stderrText = stderrBuf ? new TextDecoder().decode(stderrBuf).slice(0, 500) : "";
          log.warn(`acquireWorkdir: git clone failed (exit ${exitCode}) for ${url}${stderrText ? `: ${stderrText}` : ""}; fell back to empty workdir`);
        }
      }
    } catch {
      // directory access failed — leave it; the agent's own tools can clone
    }
    // Final safety net: git clone may have deleted the dir. Without this
    // Bun.spawn will throw ENOENT with the binary path, not the cwd path.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  async resumeOpenCodeSession(_session: OpSession): Promise<string | null> {
    return null;
  }
}

/**
 * Extract the target name of an @mention from comment text.
 *
 * Strips fenced + inline code first (terminal pastes with "user@host" / "git@repo"),
 * then matches `@name`. Rejects two phantom-mention shapes that previously spawned
 * stray agent sessions (ework-daemon#2):
 *  - scoped package refs (`@types/node`, `@babel/core` — the trailing `/` means an
 *    npm path, not a person);
 *  - version-like `@<digits>` (`@123`).
 *
 * Exported so tests can pin the exact accept/reject behavior (regression coverage).
 */
export function detectMention(text: string): string | null {
  const stripped = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const re = /(?:^|\s)@([\w\u4e00-\u9fff]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    if (!name) continue;
    if (/^\d+$/.test(name)) continue;              // @<digits> → version ref, skip
    if (stripped[re.lastIndex] === "/") continue;  // @scope/pkg → scoped package, skip
    return name;
  }
  return null;
}

/**
 * Pick the most recently active session from a list: the one whose process last
 * started (`startedAt`), falling back to creation time when a session has never
 * run yet. Returns `undefined` for an empty list.
 *
 * Used by the no-mention dispatch path to route a comment to a single session
 * (the "last AI") instead of broadcasting to all of them.
 */
export function pickLastActive(sessions: OpSession[]): OpSession | undefined {
  if (sessions.length === 0) return undefined;
  return sessions.reduce((a, b) => {
    const aT = a.startedAt ?? a.createdAt.getTime();
    const bT = b.startedAt ?? b.createdAt.getTime();
    return bT > aT ? b : a;
  });
}

// ─── Engine ───

export interface EngineOptions {
  daemonId: number;
  takeover?: TakeoverStrategy;
  backend?: RuntimeBackend;
  gateChecker?: (issue: Issue) => Promise<{ allowed: boolean; reason: string }>;
}

function createDefaultBackend(cfg: Config): RuntimeBackend {
  if (cfg.runtime === "pi" && cfg.pi) {
    return new PiBackend(cfg.pi.binary, cfg.pi.provider, cfg.pi.defaultModel, cfg.childEnvDeny);
  }
  return new OpencodeBackend(cfg.opencode.binary, cfg.opencode.dbPath, cfg.childEnvDeny);
}

export class Engine {
  private cfg: Config;
  private store: Store;
  private trackers: TrackerRegistry;
  private readonly daemonId: number;
  private readonly takeover: TakeoverStrategy;
  private readonly backend: RuntimeBackend;
  private gateChecker: (issue: Issue) => Promise<{ allowed: boolean; reason: string }>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private maxConcurrent: number;
  private maxConcurrentExplicit: boolean;

  // Runtime state keyed by session key (trackerType:scopeKey#issueId@sessionName)
  private processes = new Map<string, RuntimeHandle>();
  private running = new Set<string>();
  private stopping = new Set<string>();
  private processingComments = new Set<string>();
  private currentMessage = new Map<string, string>();
  private currentModel = new Map<string, string | undefined>();
  private lastOutputAt = new Map<string, number>();
  private startedAt = new Map<string, number>();
  private progressCommentId = new Map<string, string>();
  private pickupCommentId = new Map<string, string>();

  private nudgeRounds = new Map<string, number>();
  private emptyResponseRounds = new Map<string, number>();
  private processExitNudgeRounds = new Map<string, number>();
  private stuckNudgeRounds = new Map<string, number>();
  private currentPrompt = new Map<string, string>();
  private paused = false;

  // Generation counter per session key — incremented on every execProcess call.
  // finishRun captures the generation at start and checks it after each await.
  // If the generation changed, a new process preempted this run → bail out
  // before corrupting the new run's runtime state.
  private generation = new Map<string, number>();

  private observedIssues = new Set<string>();
  private observerTimer?: ReturnType<typeof setInterval>;

  private groupConfigs = new Map<string, GroupConfig>();
  private cloneUrls = new Map<string, string>();
  private senders = new Map<string, string>();
  private envInitialized = new Set<string>();

  private static MAX_INLINE_SIZE = 4000;
  private static MAX_NUDGE_ROUNDS = 1;
  private static MAX_EMPTY_RESPONSE_ROUNDS = 1;
  private static MAX_STUCK_NUDGE_ROUNDS = 1;
  private static OBSERVER_INTERVAL_MS = 5 * 60 * 1000;
  private static STUCK_THRESHOLD_MS = 30 * 60 * 1000;
  private static MAX_PROCESS_EXIT_NUDGE_ROUNDS = 1;

  constructor(cfg: Config, store: Store, trackers: TrackerRegistry, opts: EngineOptions) {
    this.cfg = cfg;
    this.store = store;
    this.trackers = trackers;
    this.daemonId = opts.daemonId;
    this.takeover = opts.takeover ?? new RecloneStrategy(cfg);
    this.backend = opts.backend ?? createDefaultBackend(cfg);
    this.gateChecker = opts.gateChecker ?? ((issue: Issue) => this.webGateAllows(issue));
    this.maxConcurrent = cfg.work.maxConcurrent;
    this.maxConcurrentExplicit = cfg.work.maxConcurrentExplicit;
    this.startGlobalObserver();
    void this.recover();
  }

  private workdirLink(workdir: string): string {
    const p = encodeURIComponent(workdir);
    return `[${workdir}](/file?path=${p}&daemon_id=${this.daemonId})`;
  }

  private sessionRef(session: { id: string; opencodeSessionId?: string | null }): string {
    const ses = session.opencodeSessionId || session.id;
    return `[\`${ses}\`](/sessions/${encodeURIComponent(ses)}?daemon_id=${this.daemonId})`;
  }

  /** Start the lease heartbeat. Must be called once after registerDaemon. */
  startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.store.heartbeat(this.daemonId).catch((e) => {
        log.error(`engine: heartbeat failed for daemon ${this.daemonId}:`, (e as Error).message);
      });
      void this.syncMaxConcurrent();
    }, intervalMs);
  }

  private async syncMaxConcurrent(): Promise<void> {
    if (this.maxConcurrentExplicit) return;
    try {
      const cap = await this.store.getDaemonCapacity(this.daemonId);
      if (cap != null && cap > 0 && cap !== this.maxConcurrent) {
        log.info(`engine: maxConcurrent updated ${this.maxConcurrent} → ${cap} (DB sync)`);
        this.maxConcurrent = cap;
      }
    } catch { /* non-critical */ }
  }

  private async webGateAllows(issue: Issue): Promise<{ allowed: boolean; reason: string }> {
    const parts = issue.trackerScopeKey.split("/");
    const owner = parts[0] ?? "";
    const repo = parts.slice(1).join("/");
    if (!owner || !repo) return { allowed: true, reason: "unparseable scope" };
    const url = `${this.cfg.gitea.url}/api/v1/dispatch-state?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&number=${encodeURIComponent(issue.trackerIssueId)}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Authorization: `token ${this.cfg.gitea.token}` } });
      if (!resp.ok) return { allowed: false, reason: `web returned ${resp.status}` };
      const data = await resp.json() as { dispatchOff?: boolean; aiStatus?: string };
      if (data.dispatchOff) return { allowed: false, reason: "dispatch off" };
      if (data.aiStatus === "halted" || data.aiStatus === "dispatch_off") return { allowed: false, reason: `ai_status=${data.aiStatus}` };
      return { allowed: true, reason: "ok" };
    } catch (err) {
      log.warn(`engine: web gate query failed for ${issue.trackerScopeKey}#${issue.trackerIssueId}: ${(err as Error).message} — fail-closed (skipping)`);
      return { allowed: false, reason: `web unreachable: ${(err as Error).message}` };
    }
  }

  setMaxConcurrent(n: number): void {
    if (!Number.isFinite(n) || n < 1) return;
    this.maxConcurrent = Math.floor(n);
    this.maxConcurrentExplicit = true;
    log.info(`engine: maxConcurrent set to ${this.maxConcurrent} (explicit — DB sync disabled)`);
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  getDaemonId(): number {
    return this.daemonId;
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.store.markDaemonStatus(this.daemonId, "drained");
    this.persistPaused(true);
    log.info(`engine: daemon ${this.daemonId} paused (drained) — new issues rejected, existing sessions continue`);
  }

  async resume(): Promise<void> {
    this.paused = false;
    await this.store.markDaemonStatus(this.daemonId, "active");
    this.persistPaused(false);
    log.info(`engine: daemon ${this.daemonId} resumed (active)`);
  }

  isPaused(): boolean {
    return this.paused;
  }

  getRunningCount(): number {
    return this.running.size;
  }

  /**
   * Force-terminate ALL running sessions on this daemon. Returns kill count.
   * Unlike pause() (which only rejects new work), this actively kills
   * in-progress opencode/Pi processes.
   */
  async haltAll(): Promise<number> {
    let killed = 0;
    const issues = await this.store.listOwnedIssues(this.daemonId);
    for (const issue of issues) {
      const sessions = await this.store.getSessionsForIssue(issue.id);
      for (const session of sessions) {
        if (session.state !== "running") continue;
        const k = this.sessionKey(session, issue);
        const wasKilled = await this.killSessionProcess(session, k);
        if (wasKilled) killed++;
        this.clearRuntimeState(k);
        const msgs = await this.store.getMessagesForSession(session.id);
        for (const msg of msgs) {
          if (msg.status === "pending" || msg.status === "running") {
            await this.store.updateMessageStatus(msg.id, "interrupted", "halted by admin");
          }
        }
        await this.store.updateSession(session.id, { state: "idle", opencodePid: undefined });
        const tracker = this.trackers.get(issue.trackerType);
        if (tracker) {
          try {
            await tracker.createComment(
              { trackerType: issue.trackerType, scope: issue.trackerScope, issueId: issue.trackerIssueId },
              `[system] ⏹️ Session **${session.name}** force-stopped by admin (halt-all).`
            );
          } catch { /* tracker unavailable */ }
        }
      }
    }
    this.paused = true;
    await this.store.markDaemonStatus(this.daemonId, "drained");
    this.persistPaused(true);
    log.info(`engine: haltAll complete — ${killed} sessions killed, daemon ${this.daemonId} now paused`);
    return killed;
  }

  private pausedFilePath(): string {
    return join(this.cfg.opencode.baseWorkdir, "..", ".ework-paused.flag");
  }

  private persistPaused(paused: boolean): void {
    try {
      const p = this.pausedFilePath();
      if (paused) writeFileSync(p, String(Date.now()));
      else if (existsSync(p)) unlinkSync(p);
    } catch { /* best-effort persistence */ }
  }

  restorePausedState(): void {
    try {
      if (existsSync(this.pausedFilePath())) {
        this.paused = true;
        log.info(`engine: daemon ${this.daemonId} restored paused state from flag file`);
      }
    } catch { /* best-effort */ }
  }

  /**
   * Ensure this engine owns the issue before doing work on it. Returns true
   * if we own it (either already, or just claimed). Returns false if another
   * daemon won the claim — caller must skip.
   */
  private async ensureOwned(issue: Issue): Promise<boolean> {
    if (issue.ownerDaemonId === this.daemonId) return true;
    const won = await this.store.claimIssue(issue.id, this.daemonId);
    if (!won) {
      log.info(`engine: lost claim on issue ${issue.id} to another daemon (owner=${issue.ownerDaemonId})`);
      return false;
    }
    return true;
  }

  private get stuckThresholdMs(): number {
    return this.cfg.stuck?.thresholdMs ?? Engine.STUCK_THRESHOLD_MS;
  }

  private get maxStuckNudges(): number {
    return this.cfg.stuck?.maxNudges ?? Engine.MAX_STUCK_NUDGE_ROUNDS;
  }

  private getTracker(type: string): IssueTracker {
    const tracker = this.trackers.get(type);
    if (!tracker) throw new Error(`Unknown tracker type: ${type}`);
    return tracker;
  }

  private sessionKey(session: OpSession, issue: Issue): string {
    return formatKey(issue.trackerType, issue.trackerScopeKey, issue.trackerIssueId, session.name);
  }

  private sessionToRef(session: OpSession, issue: Issue): TrackerRef {
    return { trackerType: issue.trackerType, scope: issue.trackerScope, issueId: issue.trackerIssueId };
  }

  private async resolveWorkdir(session: OpSession, issue: Issue): Promise<string> {
    const gc = this.groupConfigFor(issue);
    if (gc?.workdirTemplate && !session.workdir) {
      const dir = resolveTemplatedWorkdir(gc.workdirTemplate, issue, session, this.cfg.opencode.baseWorkdir);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    const issueMapKey = `${issue.trackerType}:${issue.trackerScopeKey}#${issue.trackerIssueId}`;
    const cloneUrl = this.cloneUrls.get(issueMapKey);
    const owner = String(issue.trackerScope["owner"] ?? issue.trackerScopeKey.split("/")[0] ?? "");
    const repo = String(issue.trackerScope["repo"] ?? issue.trackerScopeKey.split("/").slice(-1)[0] ?? "");
    const sender = this.senders.get(issueMapKey);
    const env: Record<string, string> = {
      EWORK_OWNER: owner,
      EWORK_REPO: repo,
      EWORK_ISSUE: String(issue.trackerIssueId),
    };
    if (sender) env.EWORK_SENDER = sender;
    return this.takeover.acquireWorkdir(session, issue, cloneUrl, env);
  }

  private hookEnvFor(issue: Issue, session: OpSession, workdir: string): Record<string, string> {
    const parts = issue.trackerScopeKey.split("/");
    const owner = (issue.trackerScope["owner"] as string) || parts[0] || "";
    const repo = (issue.trackerScope["repo"] as string) || parts[parts.length - 1] || "";
    const issueMapKey = `${issue.trackerType}:${issue.trackerScopeKey}#${issue.trackerIssueId}`;
    const sender = this.senders.get(issueMapKey);
    const env: Record<string, string> = {
      EWORK_OWNER: String(owner),
      EWORK_REPO: String(repo),
      EWORK_ISSUE: String(issue.trackerIssueId),
      EWORK_SESSION: session.name,
      EWORK_WORKDIR: workdir,
    };
    if (sender) env.EWORK_SENDER = sender;
    return env;
  }

  private workdirPathFor(session: OpSession, issue: Issue): string {
    if (session.workdir) {
      let dir = session.workdir;
      if (dir.startsWith("~")) dir = join(homedir(), dir.slice(1));
      return isAbsolute(dir) ? dir : resolve(this.cfg.opencode.baseWorkdir, dir);
    }
    const gc = this.groupConfigFor(issue);
    if (gc?.workdirTemplate) {
      return resolveTemplatedWorkdir(gc.workdirTemplate, issue, session, this.cfg.opencode.baseWorkdir);
    }
    const parts = issue.trackerScopeKey.split("/");
    const owner = (issue.trackerScope["owner"] as string) || parts[0] || "default";
    const repo = (issue.trackerScope["repo"] as string) || parts[parts.length - 1] || "default";
    return join(this.cfg.opencode.baseWorkdir, `${owner}--${repo}`, String(issue.trackerIssueId), session.name);
  }

  private async persistRuntimeState(sessionId: string) {
    const session = await this.store.getSession(sessionId);
    if (!session) return;
    const issue = await this.store.getIssue(session.issueId);
    if (!issue) return;
    const k = this.sessionKey(session, issue);
    await this.store.updateSession(sessionId, {
      startedAt: this.startedAt.get(k),
      progressCommentId: this.progressCommentId.get(k),
      currentPrompt: this.currentPrompt.get(k),
      lastOutputAt: this.lastOutputAt.get(k),
      nudgeRounds: this.nudgeRounds.get(k) ?? 0,
      stuckNudgeRounds: this.stuckNudgeRounds.get(k) ?? 0,
      generation: this.generation.get(k) ?? 0,
    });
  }

  private extractMentionName(text: string): string | null {
    return detectMention(text);
  }

  /**
   * Whitelist gate: default only the bot itself is a valid @mention target.
   * Unknown names (misread from plain text — `@types/node`, etc.) don't spawn a
   * new session; they fall back to broadcast. To run multiple named agents, set
   * `DAEMON_ALLOWED_AGENTS=ework,tester,...`.
   */
  private isAllowedAgent(name: string): boolean {
    const env = process.env.DAEMON_ALLOWED_AGENTS;
    const allowed = env && env.trim()
      ? env.split(",").map(s => s.trim()).filter(Boolean)
      : [this.cfg.bot.username];
    return allowed.includes(name);
  }

  private parseDirCommand(text: string): string | null {
    const match = text.match(/^\/dir\s+(\S+)/m);
    return match?.[1] ?? null;
  }

  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "less than 1 minute";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
  }

  private isSystemComment(comment: TrackerComment): boolean {
    return comment.body.startsWith(SYSTEM_PREFIX);
  }

  private countAIReplies(comments: TrackerComment[], tracker: IssueTracker): number {
    return comments.filter(c => tracker.isBotUser(c.author) && !this.isSystemComment(c)).length;
  }

  private hasRecentBotReply(comments: TrackerComment[], tracker: IssueTracker, promptTime?: number): boolean {
    return hasRecentBotReply(comments, (a) => tracker.isBotUser(a), promptTime);
  }

  private lastBotReply(comments: TrackerComment[], tracker: IssueTracker): TrackerComment | undefined {
    return [...comments].reverse().find(c => tracker.isBotUser(c.author) && !this.isSystemComment(c));
  }

  // ─── Event Dispatch ───

  async handleEvent(event: TrackerEvent, groupConfig?: GroupConfig) {
    const { ref, issue: issueData } = event;
    const tracker = this.getTracker(ref.trackerType);
    const scopeKey = tracker.formatScopeKey(ref.scope);

    if (this.paused && (event.type === "issue_opened" || event.type === "comment_created")) {
      log.info(`engine: paused — skipping ${event.type} for ${ref.trackerType}:${scopeKey}#${ref.issueId}`);
      return;
    }

    if ((issueData.ai_status === "halted" || issueData.ai_status === "dispatch_off") && (event.type === "issue_opened" || event.type === "comment_created")) {
      log.info(`engine: issue ${issueData.ai_status} — skipping ${event.type} for ${ref.trackerType}:${scopeKey}#${ref.issueId}`);
      return;
    }

    if (event.dispatch_off && event.type === "issue_opened") {
      log.info(`engine: dispatch_off (global/project) — skipping issue_opened for ${ref.trackerType}:${scopeKey}#${ref.issueId}`);
      return;
    }

    if (event.type === "comment_created" && event.comment?.author) {
      const author = event.comment.author;
      const authorKind = event.comment.authorKind ?? "human";
      const d = this.cfg.daemon;
      const noWake = [...d.nonWakingAuthors, ...d.noWakeLogins];
      if (noWake.includes(author)) {
        log.info(`engine: non-waking author ${author} — skipping comment_created for ${ref.trackerType}:${scopeKey}#${ref.issueId}`);
        return;
      }
      if (d.wakeLogins.length > 0 && !d.wakeLogins.includes(author)) {
        log.info(`engine: author ${author} not in wakeLogins — skipping comment_created for ${ref.trackerType}:${scopeKey}#${ref.issueId}`);
        return;
      }
      if (!d.wakeKinds.includes(authorKind)) {
        log.info(`engine: author kind ${authorKind} not in wakeKinds [${d.wakeKinds.join(",")}] — skipping comment_created for ${ref.trackerType}:${scopeKey}#${ref.issueId}`);
        return;
      }
    }

    const issueMapKey = `${ref.trackerType}:${scopeKey}#${ref.issueId}`;
    if (groupConfig) {
      this.groupConfigs.set(issueMapKey, groupConfig);
    }
    if (event.cloneUrl) {
      this.cloneUrls.set(issueMapKey, event.cloneUrl);
    }
    if (event.sender) {
      this.senders.set(issueMapKey, event.sender);
    }

    switch (event.type) {
      case "issue_opened":
        return this.handleOpened(ref, scopeKey, issueData, tracker, event.model);
      case "comment_created":
        return this.handleCommented(ref, scopeKey, issueData, event.comment!, tracker, event.model);
      case "issue_closed":
        return this.handleClosed(ref, scopeKey, tracker);
      case "status_changed": {
        const to = event.status?.to;
        if (to === "halted") return this.handleHalted(ref, scopeKey, tracker);
        return;
      }
    }
  }

  private groupConfigFor(issue: Issue): GroupConfig | undefined {
    return this.groupConfigs.get(`${issue.trackerType}:${issue.trackerScopeKey}#${issue.trackerIssueId}`);
  }

  private async handleOpened(
    ref: TrackerRef,
    scopeKey: string,
    issueData: TrackerEvent["issue"],
    tracker: IssueTracker,
    model?: string,
  ) {
    // Create or find issue
    const issue = await this.store.findOrCreateIssue(ref, scopeKey, issueData.title);
    if (issue.state === "closed") {
      // Issue was closed before, now reopened
      await this.store.updateIssueState(issue.id, "active");
      issue.state = "active";
    } else if (issue.state === "created") {
      await this.store.updateIssueState(issue.id, "active");
      issue.state = "active";
    }

    // Multi-machine: claim before doing work. If another daemon already owns
    // this issue, skip — they will handle it.
    if (!(await this.ensureOwned(issue))) return;
    issue.ownerDaemonId = this.daemonId;

    // Start observer for this issue
    this.startObserver(issue);

    // Create default session for bot user
    const defaultSessionName = this.cfg.bot.username;
    let session = await this.store.getSessionByName(issue.id, defaultSessionName);
    if (session && session.state === "running") {
      log.info(`engine: duplicate issue_opened — session already running for ${scopeKey}#${ref.issueId}`);
      this.startObserver(issue);
      return;
    }
    if (!session) {
      session = await this.store.createSession(issue.id, defaultSessionName);
    }

    const k = this.sessionKey(session, issue);

    // Ack before resolving the workdir: a first-touch clone can take minutes
    // (or hit the 10-min cap), and the user must see pickup feedback immediately.
    // The session link is a placeholder until the backend reports its session id;
    // the onSessionId callback rewrites this comment with the real reference.
    await tracker.createComment(ref, `[system] 🔄 **${session.name}** picked up this issue — preparing workspace…`).then(
      (c) => this.pickupCommentId.set(k, c.id),
      () => {},
    );
    void tracker.updateStatus(ref, "processing");
    const workdir = await this.resolveWorkdir(session, issue);
    log.info(`engine: session "${session.name}" created for ${k}, workdir=${workdir}`);

    const instructions = tracker.getTrackerInstructions(ref);
    const payloadClone = this.cloneUrls.get(`${ref.trackerType}:${scopeKey}#${ref.issueId}`);
    if (payloadClone) instructions.clone = `git clone ${payloadClone} .`;
    const prompt = this.buildInitialPrompt(
      session.name, issueData.title,
      this.handleLargeContent(workdir, issueData.body, "issue-body.txt"),
      issueData.author, workdir, instructions
    );
    await this.enqueueOrRun(session, issue, prompt, undefined, model);
  }

  private async handleCommented(
    ref: TrackerRef,
    scopeKey: string,
    issueData: TrackerEvent["issue"],
    comment: NonNullable<TrackerEvent["comment"]>,
    tracker: IssueTracker,
    model?: string,
  ) {
    if (!comment) return;

    if (tracker.isBotUser(comment.author)) {
      log.info(`engine: ignoring own comment on ${scopeKey}#${ref.issueId}`);
      return;
    }

    if (issueData.state !== "open") return;

    if (comment.id) {
      if (this.processingComments.has(comment.id) || await this.store.findMessageByCommentId(comment.id)) {
        log.info(`engine: duplicate comment ${comment.id}, skipping`);
        return;
      }
      this.processingComments.add(comment.id);
    }

    try {
    // Find issue
    let issue = await this.store.findIssue(ref.trackerType, scopeKey, ref.issueId);
    if (!issue) {
      // Issue not tracked yet — auto-track it
      issue = await this.store.findOrCreateIssue(ref, scopeKey, issueData.title);
      await this.store.updateIssueState(issue.id, "active");
      issue.state = "active";
      this.startObserver(issue);
    } else if (issue.state === "closed") {
      log.info(`engine: issue ${scopeKey}#${ref.issueId} is closed in DB, skipping comment`);
      return;
    }

    // Multi-machine: claim before doing work.
    if (!(await this.ensureOwned(issue))) return;
    issue.ownerDaemonId = this.daemonId;

    const dirPath = this.parseDirCommand(comment.body);
    const rawMention = this.extractMentionName(comment.body);
    // Gate extracted @mentions through the agent whitelist. An unknown name
    // (e.g. `@types` misread from `@types/node`) is treated as no mention and
    // falls through to broadcast instead of spawning a phantom session (ework-daemon#2).
    const mentionName = rawMention && this.isAllowedAgent(rawMention) ? rawMention : null;
    if (rawMention && !mentionName) {
      log.info(`engine: @${rawMention} is not an allowed agent — routing to last session instead of spawning`);
    }

    if (mentionName) {
      // @mention → targeted delivery
      let session = await this.store.getSessionByName(issue.id, mentionName);

      if (session) {
        // Forward to existing session
        if (dirPath) {
          await this.store.updateSession(session.id, { workdir: dirPath });
          session.workdir = dirPath;
        }
        const workdir = await this.resolveWorkdir(session, issue);
        const instructions = tracker.getTrackerInstructions(ref);
        const prompt = this.buildForwardPrompt(
          session.name, this.handleLargeContent(workdir, comment.body, `comment-${comment.id}.txt`),
          comment.author, comment.authorKind, issueData.title, workdir, instructions
        );

        // Immediate ack
        await tracker.createComment(ref, `[system] ✓ Message forwarded to **${session.name}**${this.running.has(this.sessionKey(session, issue)) ? " (running)" : ""}.\n> session: ${this.sessionRef(session)} | workdir: ${this.workdirLink(workdir)}`);

        await this.enqueueOrRun(session, issue, prompt, comment.id, model);
      } else {
        // Create new session
        session = await this.store.createSession(issue.id, mentionName);
        if (dirPath) {
          await this.store.updateSession(session.id, { workdir: dirPath });
          session.workdir = dirPath;
        }
        const workdir = await this.resolveWorkdir(session, issue);

        await tracker.createComment(ref, `[system] 🔄 **${session.name}** joined the conversation.`);

        const instructions = tracker.getTrackerInstructions(ref);
        const payloadClone = this.cloneUrls.get(`${ref.trackerType}:${scopeKey}#${ref.issueId}`);
        if (payloadClone) instructions.clone = `git clone ${payloadClone} .`;
        const prompt = this.buildInitialPrompt(
          session.name, issueData.title,
          this.handleLargeContent(workdir, issueData.body, "issue-body.txt"),
          issueData.author, workdir, instructions
        );
        await this.enqueueOrRun(session, issue, prompt, comment.id, model);
      }
    } else {
      // No valid @mention → forward to the most recently active session only.
      // Broadcasting to all sessions makes multiple AIs race on the same request;
      // routing to the last-active lets the user continue without re-@mentioning,
      // while @mention switches to a different AI.
      const sessions = await this.store.getSessionsForIssue(issue.id);
      let session: OpSession;
      if (sessions.length === 0) {
        log.info(`engine: no session for ${scopeKey}#${ref.issueId} — creating default "${this.cfg.bot.username}"`);
        session = await this.store.createSession(issue.id, this.cfg.bot.username);
      } else {
        const picked = pickLastActive(sessions);
        if (!picked) return;
        session = picked;
      }
      if (dirPath) {
        await this.store.updateSession(session.id, { workdir: dirPath });
        session.workdir = dirPath;
      }
      const workdir = await this.resolveWorkdir(session, issue);
      const instructions = tracker.getTrackerInstructions(ref);
      const prompt = this.buildForwardPrompt(
        session.name, this.handleLargeContent(workdir, comment.body, `comment-${comment.id}.txt`),
        comment.author, comment.authorKind, issueData.title, workdir, instructions
      );
      await tracker.createComment(ref, `[system] ✓ Message forwarded to **${session.name}**${this.running.has(this.sessionKey(session, issue)) ? " (running)" : ""}.\n> session: ${this.sessionRef(session)} | workdir: ${this.workdirLink(workdir)}`);
      await this.enqueueOrRun(session, issue, prompt, comment.id, model);
    }
    } finally {
      if (comment.id) this.processingComments.delete(comment.id);
    }
  }

  private async handleClosed(
    ref: TrackerRef,
    scopeKey: string,
    tracker: IssueTracker
  ) {
    const issue = await this.store.findIssue(ref.trackerType, scopeKey, ref.issueId);
    if (!issue) return;
    if (issue.state === "closed") return;

    await this.store.updateIssueState(issue.id, "closed");
    this.stopObserver(issue.id);

    // Kill all running processes for this issue's sessions
    const sessions = await this.store.getSessionsForIssue(issue.id);
    let killedCount = 0;
    for (const session of sessions) {
      const k = this.sessionKey(session, issue);
      const killed = await this.killSessionProcess(session, k);
      if (killed) killedCount++;
      this.clearRuntimeState(k);
      const msgs = await this.store.getMessagesForSession(session.id);
      for (const msg of msgs) {
        if (msg.status === "pending" || msg.status === "running") {
          await this.store.updateMessageStatus(msg.id, "interrupted", "issue closed");
        }
      }
      await this.store.updateSession(session.id, { state: "idle", opencodePid: undefined });
    }

    const gcKey = `${ref.trackerType}:${scopeKey}#${ref.issueId}`;
    const gc = this.groupConfigFor(issue);
    if (gc?.destroyScript) {
      const workdirs = new Set<string>();
      for (const session of sessions) {
        const workdir = this.workdirPathFor(session, issue);
        if (existsSync(workdir)) workdirs.add(workdir);
      }
      for (const workdir of workdirs) {
        await runHookScript(gc.destroyScript, workdir, `destroyScript for ${scopeKey}#${ref.issueId}`, this.hookEnvFor(issue, { name: "" } as OpSession, workdir));
      }
    }
    if (this.groupConfigs.get(gcKey) === gc) this.groupConfigs.delete(gcKey);
    this.cloneUrls.delete(gcKey);
    this.senders.delete(gcKey);

    log.info(`engine: issue closed, ${killedCount}/${sessions.length} sessions killed for ${scopeKey}#${ref.issueId}`);
    void tracker.updateStatus(ref, "completed");
  }

  private async handleHalted(
    ref: TrackerRef,
    scopeKey: string,
    tracker: IssueTracker
  ) {
    const issue = await this.store.findIssue(ref.trackerType, scopeKey, ref.issueId);
    if (!issue) return;
    this.stopObserver(issue.id);
    const sessions = await this.store.getSessionsForIssue(issue.id);
    let killedCount = 0;
    for (const session of sessions) {
      const k = this.sessionKey(session, issue);
      const killed = await this.killSessionProcess(session, k);
      if (killed) killedCount++;
      this.clearRuntimeState(k);
      const msgs = await this.store.getMessagesForSession(session.id);
      for (const msg of msgs) {
        if (msg.status === "pending" || msg.status === "running") {
          await this.store.updateMessageStatus(msg.id, "interrupted", "halted by user");
        }
      }
      await this.store.updateSession(session.id, { state: "idle", opencodePid: undefined });
    }
    log.info(`engine: issue halted, ${killedCount}/${sessions.length} sessions killed for ${scopeKey}#${ref.issueId}`);
    try { await tracker.createComment(ref, "[system] ⏸️ AI processing halted by user."); } catch { /* tracker unavailable */ }
  }

  private clearRuntimeState(k: string) {
    this.processes.delete(k);
    this.running.delete(k);
    this.stopping.delete(k);
    this.currentMessage.delete(k);
    this.currentModel.delete(k);
    this.lastOutputAt.delete(k);
    this.startedAt.delete(k);
    this.progressCommentId.delete(k);
    this.nudgeRounds.delete(k);
    this.processExitNudgeRounds.delete(k);
    this.stuckNudgeRounds.delete(k);
    this.currentPrompt.delete(k);
    this.generation.delete(k);
  }

  private async killSessionProcess(session: OpSession, k: string): Promise<boolean> {
    const handle = this.processes.get(k);
    if (handle) {
      this.stopping.add(k);
      try { this.killProcessTree(handle.pid, "SIGTERM"); } catch { /* already dead */ }
      this.processes.delete(k);
      return true;
    }

    const pid = session.opencodePid;
    if (!pid) return false;
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }

    log.info(`engine: killing orphaned pid=${pid} for ${k} (cross-restart)`);
    this.stopping.add(k);
    try {
      this.killProcessTree(pid, "SIGTERM");
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        try { process.kill(pid, 0); } catch { break; }
      }
      try { process.kill(pid, "SIGKILL"); } catch { /* dead */ }
    } catch { /* already dead */ }
    return true;
  }

  // ─── Preemptive Scheduler ───

  private async enqueueOrRun(session: OpSession, issue: Issue, prompt: string, sourceCommentId?: string, model?: string) {
    const k = this.sessionKey(session, issue);

    this.stuckNudgeRounds.delete(k);
    this.processExitNudgeRounds.delete(k);

    const msg = await this.store.createMessage(session.id, prompt, sourceCommentId, undefined, model);

    if (this.running.has(k)) {
      // PREEMPTIVE: Kill running process, new message takes priority
      log.info(`engine: preempting ${k} with new message ${msg.id.slice(0, 8)}`);
      await this.preemptSession(k, session, issue, msg);
      return;
    }

    if (this.running.size >= this.maxConcurrent) {
      log.info(`engine: concurrency limit reached (${this.running.size}/${this.maxConcurrent}), message ${msg.id.slice(0, 8)} queued for ${k}`);
      return;
    }

    // Not running — execute directly
    await this.executeMessage(k, session, issue, msg);
  }

  private async preemptSession(k: string, session: OpSession, issue: Issue, newMsg: Message) {
    const proc = this.processes.get(k);
    const oldMsgId = this.currentMessage.get(k);

    // Mark old message as interrupted
    if (oldMsgId) {
      await this.store.updateMessageStatus(oldMsgId, "interrupted", "preempted by new message");
    }

    // Kill running process
    if (proc) {
      this.stopping.add(k);
       try { this.killProcessTree(proc.pid); } catch { /* already dead */ }
      this.processes.delete(k);
      this.lastOutputAt.delete(k);
    }

    // Don't clear stopping — let old execProcess detect preemption via process reference mismatch
    this.running.delete(k);
    this.currentMessage.delete(k);
    this.currentModel.delete(k);
    this.startedAt.delete(k);

    // Execute new message
    await this.executeMessage(k, session, issue, newMsg);
  }

  private async executeMessage(k: string, session: OpSession, issue: Issue, msg: Message) {
    log.info(`engine: executing msg ${msg.id.slice(0, 8)} for ${k}`);

    // Multi-machine: atomic message claim. Pending → running, only if we win.
    // Locally-created messages always succeed (no contention); this gates the
    // cross-daemon race when peer daemons share the session.
    const won = await this.store.claimMessage(msg.id);
    if (!won) {
      log.info(`engine: lost message claim for ${msg.id.slice(0, 8)}, another daemon took it`);
      return;
    }

    this.running.add(k);
    this.currentMessage.set(k, msg.id);

    // Update session state
    await this.store.updateSession(session.id, { state: "running" });

    // Every execution path funnels through here (opened, commented, new-session
    // on comment, preempt re-run, retry) — the badge must flip for all of them,
    // not only for the initial issue-opened ack.
    const tracker = this.trackers.get(issue.trackerType);
    if (tracker) {
      void tracker.updateStatus(
        { trackerType: issue.trackerType, scope: issue.trackerScope, issueId: issue.trackerIssueId },
        "processing",
      );
    }

    void this.execProcess(k, session, issue, msg);
  }

  // ─── Process Manager ───

  private async execProcess(k: string, session: OpSession, issue: Issue, msg: Message) {
    const gate = await this.gateChecker(issue);
    if (!gate.allowed) {
      log.info(`engine: execProcess blocked by web gate (${gate.reason}) for ${k}`);
      await this.store.updateMessageStatus(msg.id, "failed", `gate: ${gate.reason}`);
      this.running.delete(k);
      this.currentMessage.delete(k);
      this.currentModel.delete(k);
      void this.dequeueAfterGate(k, session, issue);
      return;
    }

    const gen = (this.generation.get(k) ?? 0) + 1;
    this.generation.set(k, gen);

    const workdir = await this.resolveWorkdir(session, issue);

    const gc = this.groupConfigFor(issue);
    if (gc?.envInitScript && !this.envInitialized.has(workdir)) {
      await runHookScript(gc.envInitScript, workdir, `envInitScript for ${k}`, this.hookEnvFor(issue, session, workdir));
      this.envInitialized.add(workdir);
    }
    if (gc?.initScript) {
      await runHookScript(gc.initScript, workdir, `initScript for ${k}`, this.hookEnvFor(issue, session, workdir));
    }

    const ref = this.sessionToRef(session, issue);
    const tracker = this.getTracker(issue.trackerType);

    let resumeSessionId = session.opencodeSessionId;
    if (!resumeSessionId) {
      const fromStrategy = await this.takeover.resumeOpenCodeSession(session);
      if (fromStrategy) resumeSessionId = fromStrategy;
    }
    if (resumeSessionId && !(await this.backend.sessionExists(resumeSessionId))) {
      log.warn(`stale session ${resumeSessionId} not found in db, starting fresh`);
      resumeSessionId = undefined;
      await this.store.updateSession(session.id, { opencodeSessionId: undefined });
    }

    const model = msg.model || (this.cfg.runtime === "pi" && this.cfg.pi ? this.cfg.pi.defaultModel : this.cfg.opencode.defaultModel);
    this.currentModel.set(k, model);

    if (msg.sourceCommentId) {
      try { await tracker.setReaction(ref, msg.sourceCommentId, "eyes"); } catch { /* non-critical */ }
    }

    const childEnv = { ...process.env, ...this.hookEnvFor(issue, session, workdir) };

    let exitCode: number | null = null;

    try {
      const handle = await this.backend.spawn(
        {
          workdir,
          prompt: msg.content,
          model: model || undefined,
          resumeSessionId: resumeSessionId || undefined,
          env: childEnv,
        },
        {
          onOutput: () => { this.lastOutputAt.set(k, Date.now()); },
          onSessionId: async (id: string) => {
            if (!session.opencodeSessionId) {
              await this.store.updateSession(session.id, { opencodeSessionId: id });
              session.opencodeSessionId = id;
              log.info(`engine: captured sessionID=${id.slice(0, 8)} for ${k} (early persist)`);
              const pickupId = this.pickupCommentId.get(k);
              if (pickupId) {
                this.pickupCommentId.delete(k);
                await tracker
                  .editComment(ref, pickupId, `[system] 🔄 **${session.name}** picked up this issue.\n> session: ${this.sessionRef(session)} | workdir: ${this.workdirLink(workdir)}`)
                  .catch((err) => log.error(`engine: failed to rewrite pickup comment for ${k}:`, (err as Error).message));
              }
            }
          },
        },
      );

      if (this.generation.get(k) !== gen) {
        log.warn(`engine: spawned pid=${handle.pid} but generation superseded — killing orphan for ${k}`);
        try { this.killProcessTree(handle.pid); } catch { /* already dead */ }
        return;
      }

      this.processes.set(k, handle);
      this.lastOutputAt.set(k, Date.now());
      if (!this.startedAt.has(k)) this.startedAt.set(k, Date.now());
      this.currentPrompt.set(k, msg.content);

      await this.store.updateSession(session.id, { opencodePid: handle.pid });
      await this.persistRuntimeState(session.id);

      log.info(`engine: spawned pid=${handle.pid} for ${k} (backend=${this.backend.name})`);

      exitCode = await handle.exited;
      const stderr = await handle.stderrText;

      if (this.processes.get(k) !== handle) {
        log.info(`engine: process replaced, skipping finishRun for ${k}`);
        this.stopping.delete(k);
        return;
      }

      this.processes.delete(k);
      this.lastOutputAt.delete(k);
      await this.store.updateSession(session.id, { opencodePid: undefined });

      if (exitCode !== 0) {
        log.error(`engine: pid=${handle.pid} exited ${exitCode} for ${k}`);
        log.error(`  stderr: ${stderr.slice(0, 2000)}`);
        await this.store.updateMessageStatus(msg.id, "failed", `exit ${exitCode}: ${stderr.slice(0, 500)}`);
      } else {
        log.info(`engine: pid=${handle.pid} completed for ${k}`);
        if (stderr) log.warn(`engine: pid=${handle.pid} stderr on exit 0: ${stderr.slice(0, 500)}`);
        if (!session.opencodeSessionId) log.warn(`engine: pid=${handle.pid} produced NO sessionID (no stdout output)`);
        await this.store.updateMessageStatus(msg.id, "done");
      }
    } catch (err) {
      log.error(`engine: exec failed for ${k}:`, err);
      await this.store.updateMessageStatus(msg.id, "failed", (err as Error).message);
    }

    await this.finishRun(k, session, issue, exitCode, gen);
  }

  private async finishRun(k: string, session: OpSession, issue: Issue, exitCode: number | null, gen: number) {
    if (this.stopping.delete(k)) {
      log.info(`engine: finishRun skipped (force-stopped) for ${k}`);
      return;
    }

    const superseded = () => this.generation.get(k) !== gen;

    // running.delete deferred to dequeuePending
    const started = this.startedAt.get(k);
    this.startedAt.delete(k);
    const usedModel = this.currentModel.get(k) ?? "";
    this.currentMessage.delete(k);
    this.currentModel.delete(k);

    const progressId = this.progressCommentId.get(k);
    const ref = this.sessionToRef(session, issue);
    const tracker = this.getTracker(issue.trackerType);

    // Edit the progress comment to show final state instead of deleting it,
    // so users can always see whether a run completed, failed, or crashed.
    // For short runs with no progress comment, only post if >3 min.
    const duration = started ? this.formatDuration(Date.now() - started) : "unknown";
    const emoji = exitCode === null ? "💥" : exitCode === 0 ? "✅" : "❌";
    const label = exitCode === null ? "spawn failed" : exitCode === 0 ? "completed" : "failed";
    const finalText = `[system] ${emoji} **${session.name}** ${label} (${duration})`;

    if (progressId) {
      try {
        await tracker.editComment(ref, progressId, finalText);
      } catch (err) {
        log.error(`engine: failed to update progress comment for ${k}:`, (err as Error).message);
      }
    } else if (started && Date.now() - started > 180_000) {
      await tracker.createComment(ref, finalText).catch(
        err => log.error("engine: completion report failed:", (err as Error).message)
      );
    }

    if (superseded()) {
      log.info(`engine: finishRun aborted (superseded) for ${k}`);
      return;
    }
    this.progressCommentId.delete(k);
    this.pickupCommentId.delete(k);
    this.currentPrompt.delete(k);
    await this.persistRuntimeState(session.id);


    // spawn failed (exitCode === null) → skip completion check
    if (exitCode === null) {
      log.info(`engine: spawn failed for ${k}, skipping completion check`);
      await this.store.updateSession(session.id, { opencodePid: undefined });
      void tracker.updateStatus(ref, "failed", "spawn failed");
      await this.deactivateIfIdle(k, session, issue);
      return;
    }
    if (superseded()) {
      log.info(`engine: finishRun aborted (superseded) for ${k}`);
      return;
    }

    // Completion check: did AI post a recent [bot] reply?
    const commentsNow = await tracker.listComments(ref).catch((): TrackerComment[] => []);
    if (superseded()) {
      log.info(`engine: finishRun aborted (superseded) for ${k}`);
      return;
    }
    const hasRecent = this.hasRecentBotReply(commentsNow, tracker, started ?? undefined);

    if (hasRecent) {
      // oldest-first comment lists would match a pre-run bot reply when started
      // is undefined; pick the LAST qualifying comment instead.
      const matched = [...commentsNow].reverse().find(c => tracker.isBotUser(c.author) && !this.isSystemComment(c) && c.createdAt && new Date(c.createdAt).getTime() > (started ?? 0));
      log.info(`engine: [bot] reply found for ${k} after prompt (comment ${matched?.id ?? "?"} createdAt ${matched?.createdAt ?? "?"}), marking done`);
      if (matched && !usedModel) {
        const fromSession = await this.backend.lastSessionModel(session.opencodeSessionId).catch(() => ({ model: "" }));
        if (fromSession.model) {
          void tracker.setCommentModel(ref, matched.id, fromSession.model).catch(() => { /* display-only */ });
        }
      }
      this.nudgeRounds.delete(k);
      this.emptyResponseRounds.delete(k);
      await this.persistRuntimeState(session.id);
      void tracker.updateStatus(ref, "");
    } else {
      const sessionOutput = await this.backend.getSessionOutputTokens(session.opencodeSessionId);
      const emptyRound = this.emptyResponseRounds.get(k) ?? 0;

      if (!sessionOutput.hasOutput && emptyRound < Engine.MAX_EMPTY_RESPONSE_ROUNDS) {
        log.warn(`engine: empty model response for ${k} (0 tokens, round ${emptyRound + 1}/${Engine.MAX_EMPTY_RESPONSE_ROUNDS}), retrying`);
        this.emptyResponseRounds.set(k, emptyRound + 1);
        this.currentPrompt.delete(k);
        await this.persistRuntimeState(session.id);

        const instructions = tracker.getTrackerInstructions(ref);
        const nudgePrompt = this.buildNudgePrompt(session, issue, instructions);
        const nudgeMsg = await this.store.createMessage(session.id, nudgePrompt, undefined, undefined, this.currentModel.get(k));
        await this.dequeueOrIdle(k, session, issue, nudgeMsg);
        return;
      }

      if (!sessionOutput.hasOutput && emptyRound >= Engine.MAX_EMPTY_RESPONSE_ROUNDS) {
        log.error(`engine: empty model response for ${k} after ${emptyRound} retries, reporting error`);
        this.emptyResponseRounds.delete(k);
        this.nudgeRounds.delete(k);
        await tracker.createComment(ref, `[system] ❌ **${session.name}** 模型返回空响应（0 token），已重试 ${emptyRound} 次。请检查模型配置或稍后重试。`).catch(() => {});
        void tracker.updateStatus(ref, "failed", "empty model response");
      } else {
        const nudgeRound = this.nudgeRounds.get(k) ?? 0;
        if (exitCode === 0 && nudgeRound < Engine.MAX_NUDGE_ROUNDS) {
          log.info(`engine: no [bot] reply for ${k} (promptTime=${started ?? "unknown"}), nudging (round ${nudgeRound + 1}/${Engine.MAX_NUDGE_ROUNDS})`);
          this.nudgeRounds.set(k, nudgeRound + 1);
          this.currentPrompt.delete(k);
          await this.persistRuntimeState(session.id);

          const instructions = tracker.getTrackerInstructions(ref);
          const nudgePrompt = this.buildNudgePrompt(session, issue, instructions);
          const nudgeMsg = await this.store.createMessage(session.id, nudgePrompt, undefined, undefined, this.currentModel.get(k));
          await this.dequeueOrIdle(k, session, issue, nudgeMsg);
          return;
        }
        log.info(`engine: no [bot] reply for ${k} (promptTime=${started ?? "unknown"}), marking done (nudge exhausted or process failed)`);
        this.nudgeRounds.delete(k);
        const detail = exitCode === 0 ? "ran but did not post a reply" : `crashed (exit ${exitCode})`;
        await tracker.createComment(ref, `[system] ❌ **${session.name}** ${detail}. Try posting again or @${session.name} to retry.`).catch(() => {});
        void tracker.updateStatus(ref, "failed", detail);
      }
    }

    // Remove eyes on source comment; react +1/-1 on the bot's last reply (fallback: source)
    const recentMsgs = await this.store.getRecentMessages(session.id, 1);
    const lastMsg = recentMsgs[0];
    if (lastMsg?.sourceCommentId) {
      // Check if any other session is still running on this issue
      const prefix = `${issue.trackerType}:${issue.trackerScopeKey}#${issue.trackerIssueId}@`;
      const stillRunning = [...this.running].some(rk => rk.startsWith(prefix) && rk !== k);
      if (!stillRunning) {
        try {
          await tracker.setReaction(ref, lastMsg.sourceCommentId, "eyes", true);
          const reaction = exitCode === 0 ? "+1" : "-1";
          const targetId = lastMsg.sourceCommentId;
          await tracker.setReaction(ref, targetId, reaction);
        } catch { /* non-critical */ }
      }
    }

    if (superseded()) {
      log.info(`engine: finishRun aborted (superseded) for ${k}`);
      return;
    }
    await this.deactivateIfIdle(k, session, issue);
  }

  private async deactivateIfIdle(k: string, session: OpSession, issue: Issue) {
    const nextMsg = await this.store.getNextPendingMessage(session.id);
    if (nextMsg) {
      const current = await this.store.getSession(session.id);
      if (current && current.state !== "idle") {
        if (this.running.size >= this.maxConcurrent) {
          log.info(`engine: concurrency limit (${this.running.size}/${this.maxConcurrent}), keeping msg ${nextMsg.id.slice(0, 8)} pending for ${k}`);
        } else {
          await this.dequeueOrIdle(k, current, issue, nextMsg);
          return;
        }
      }
    }

    this.clearRuntimeState(k);
    await this.store.updateSession(session.id, { state: "idle" });

    void this.drainGlobalPending();
  }

  private async dequeueAfterGate(k: string, session: OpSession, issue: Issue): Promise<void> {
    const next = await this.store.getNextPendingMessage(session.id);
    if (!next) return;
    await this.dequeueOrIdle(k, session, issue, next);
  }

  private async drainGlobalPending(): Promise<void> {
    const slotsAvailable = this.maxConcurrent - this.running.size;
    if (slotsAvailable <= 0) return;
    const pending = await this.store.getGlobalPendingMessages(slotsAvailable);
    for (const msg of pending) {
      if (this.running.size >= this.maxConcurrent) break;
      const session = await this.store.getSession(msg.sessionId);
      if (!session || session.state === "running") continue;
      const issue = await this.store.getIssue(session.issueId);
      if (!issue || issue.state === "closed") continue;
      const k = this.sessionKey(session, issue);
      if (this.running.has(k)) continue;
      const won = await this.store.claimMessage(msg.id);
      if (!won) continue;
      log.info(`engine: drainGlobalPending picked up msg ${msg.id.slice(0, 8)} for ${k}`);
      await this.dequeueOrIdle(k, session, issue, msg);
    }
  }

  private async dequeueOrIdle(k: string, session: OpSession, issue: Issue, msg: Message) {
    log.info(`engine: running dequeued msg ${msg.id.slice(0, 8)} for ${k}`);
    await this.store.updateMessageStatus(msg.id, "running");
    this.running.add(k);
    this.currentMessage.set(k, msg.id);
    await this.store.updateSession(session.id, { state: "running" });
    void this.execProcess(k, session, issue, msg);
  }

  // ─── Prompts ───

  private buildInitialPrompt(
    opName: string,
    title: string,
    body: string,
    author: string,
    workdir: string,
    instructions: { clone: string; issueRef: string; closeIssue?: string }
  ): string {
    return [
      `You are ${opName}, the AI agent for this project on ework (a self-hosted, issue-driven dev platform).`,
      `Who's who: issue comments come from the project's users (humans like @${author}; bots are labelled "bot") and are forwarded to you verbatim. Your \`reply\` tool posts a comment they read (prefixed \`[bot]\`). Lines starting with \`[system]\` are platform plumbing, not user speech.`,
      `The working directory below is your own clone of the repo. Only claim actions you actually performed — verify with tools (git status/log) before asserting any push, merge, or change.`,
      ``,
      `A new issue needs your attention:`,
      `- Issue: "${title}" (${instructions.issueRef})`,
      `- Author: @${author}`,
      ``,
      `### Issue Body`,
      body,
      ``,
      `### Repository`,
      `Working directory: \`${workdir}\``,
      `If it's empty, clone the repo: \`${instructions.clone}\``,
      ``,
      `Read the issue, work on it, and reply via the \`reply\` tool — every reply starts with \`[bot]\`. Post the reply as soon as possible, then continue working if needed.`,
    ].filter(Boolean).join("\n");
  }

  private buildForwardPrompt(
    opName: string,
    commentBody: string,
    commentUser: string,
    authorKind: string | undefined,
    issueTitle: string,
    workdir: string,
    instructions: { issueRef: string }
  ): string {
    const who = authorKind === "bot" ? `@${commentUser} (bot)` : `@${commentUser} (user)`;
    return [
      `[SYSTEM FORWARD] User ${who} posted a new comment on ${instructions.issueRef} "${issueTitle}".`,
      `The platform forwarded it to you; the user cannot see your terminal output —`,
      `your reply tool posts a \`[bot]\` comment into the thread they read.`,
      ``,
      `---`,
      commentBody,
      `---`,
      ``,
      `Working directory: ${workdir}`,
      ``,
      `Reply using the \`reply\` tool.`,
    ].join("\n");
  }

  private buildNudgePrompt(
    session: OpSession,
    issue: Issue,
    instructions: { issueRef: string }
  ): string {
    return [
      `[SYSTEM NUDGE] You completed a task on ${instructions.issueRef} but did not post a reply.`,
      ``,
      `Post a reply now using the \`reply\` tool. Summarize what you did and the outcome.`,
      `Every reply MUST start with \`[bot]\` prefix.`,
    ].join("\n");
  }

  private buildProcessExitNudgePrompt(
    session: OpSession,
    issue: Issue,
    instructions: { issueRef: string }
  ): string {
    return [
      `[SYSTEM] 检测到你的进程已经退出，可能意味着您已经完成了阶段性工作或者因为某些原因中断。`,
      ``,
      `- 如果您确认完成了阶段性工作，您应该向用户报告结果。因为用户只能在 issue 上查看结果或者听取汇报。`,
      `- 如果您是因为某些原因中断而不需要向用户汇报中间结果，请继续您未完成的工作。`,
      `- 如果您因为某些不确定，必须向用户请教，请务必向用户汇报后再继续。`,
      ``,
      `使用 \`reply\` 工具向 ${instructions.issueRef} 给出回复（以 \`[bot]\` 开头）。其他方式的回复会被忽略。`,
    ].join("\n");
  }

  private buildStuckNudgePrompt(
    session: OpSession,
    issue: Issue,
    instructions: { issueRef: string },
    stuckMinutes: number
  ): string {
    return [
      `[SYSTEM] 检测到您的进程已经卡住 ${stuckMinutes} 分钟没有输出了，已经被强制重启。`,
      ``,
      `可能的原因：等待输入、死循环、网络请求挂起、长时间无响应的工具调用等。`,
      ``,
      `- 如果您之前的工作有阶段性成果，请立即向用户汇报当前进度和遇到的问题。`,
      `- 如果您遇到了阻塞（权限不足、依赖缺失、不确定的方向等），请向用户说明并请求指导。`,
      `- 如果您可以继续，请避开导致卡住的操作，换一种方式继续工作。`,
      ``,
      `使用 \`reply\` 工具向 ${instructions.issueRef} 给出回复（以 \`[bot]\` 开头）。其他方式的回复会被忽略。`,
    ].join("\n");
  }

  private handleLargeContent(workdir: string, content: string, filename: string): string {
    if (content.length <= Engine.MAX_INLINE_SIZE) return content;

    const dir = join(workdir, ".ework-daemon");
    mkdirSync(dir, { recursive: true });
    const absPath = join(dir, filename);
    writeFileSync(absPath, content);

    return [
      `[Large content: ${content.length} chars, saved to \`${absPath}\`]`,
      `Read: \`cat '${absPath}'\``,
      `Search: \`grep "pattern" '${absPath}'\``,
    ].join("\n");
  }

  // ─── IssueObserver (Global Polling) ───

  private startGlobalObserver() {
    // Single global timer that checks all active issues
    this.observerTimer = setInterval(() => this.runObserverCycle(), Engine.OBSERVER_INTERVAL_MS);
  }

  private startObserver(issue: Issue) {
    if (this.observedIssues.has(issue.id)) return;
    this.observedIssues.add(issue.id);
    log.info(`engine: observer started for issue ${issue.trackerScopeKey}#${issue.trackerIssueId}`);
  }

  private stopObserver(issueId: string) {
    this.observedIssues.delete(issueId);
  }

  private async runObserverCycle() {
    try {
      await this.store.releaseDeadOwners(this.cfg.work.leaseTtlMs);
    } catch (err) {
      log.error("engine: releaseDeadOwners failed:", (err as Error).message);
    }

    let ownedIssues;
    try {
      ownedIssues = (await this.store.listOwnedIssues(this.daemonId))
        .filter((i) => this.observedIssues.has(i.id));
    } catch (err) {
      log.error("engine: listOwnedIssues failed:", (err as Error).message);
      return;
    }

    for (const issue of ownedIssues) {
      try {
    const gate = await this.gateChecker(issue);
        if (!gate.allowed) {
          log.info(`engine: observer — web gate blocked ${issue.trackerScopeKey}#${issue.trackerIssueId} (${gate.reason})`);
          continue;
        }
        await this.observeIssue(issue);
      } catch (err) {
        log.error(`engine: observer error for ${issue.trackerScopeKey}#${issue.trackerIssueId}:`, (err as Error).message);
      }
    }
  }

  private async observeIssue(issue: Issue) {
    const tracker = this.getTracker(issue.trackerType);
    const sessions = await this.store.getSessionsForIssue(issue.id);

    for (const session of sessions) {
      if (session.state !== "running") continue;

      const k = this.sessionKey(session, issue);
      const proc = this.processes.get(k);
      const lastTs = this.lastOutputAt.get(k);

      if (proc) {
        // Process exists — check if alive
        try { process.kill(proc.pid, 0); } catch {
          // Stale reference: execProcess may have already cleaned up
          if (this.processes.get(k) !== proc) continue;

          // Process died unexpectedly
          log.warn(`engine: observer detected dead process for ${k}`);
          this.processes.delete(k);
          this.lastOutputAt.delete(k);
          this.running.delete(k);
          await this.store.updateSession(session.id, { state: "idle", opencodePid: undefined });

          // Mark running message as failed
          const msgId = this.currentMessage.get(k);
          if (msgId) {
            await this.store.updateMessageStatus(msgId, "failed", "process died unexpectedly");
            this.currentMessage.delete(k);
    this.currentModel.delete(k);
          }

          const ref = this.sessionToRef(session, issue);
          const exitNudgeRound = this.processExitNudgeRounds.get(k) ?? 0;
          if (exitNudgeRound < Engine.MAX_PROCESS_EXIT_NUDGE_ROUNDS) {
            const comments = await tracker.listComments(ref).catch(() => []);
            const aiReplies = this.countAIReplies(comments, tracker);

            if (aiReplies === 0) {
              log.info(`engine: process died and no bot reply for ${k}, sending process-exit nudge (round ${exitNudgeRound + 1}/${Engine.MAX_PROCESS_EXIT_NUDGE_ROUNDS})`);
              await tracker.createComment(ref, `[system] 💀 **${session.name}** process exited unexpectedly, restarting...`).catch(
                err => log.error(`engine: process-exit comment failed for ${k}:`, (err as Error).message)
              );
              this.processExitNudgeRounds.set(k, exitNudgeRound + 1);
              this.currentPrompt.delete(k);

              const instructions = tracker.getTrackerInstructions(ref);
              const nudgePrompt = this.buildProcessExitNudgePrompt(session, issue, instructions);
              const nudgeMsg = await this.store.createMessage(session.id, nudgePrompt, undefined, undefined, this.currentModel.get(k));
              await this.dequeueOrIdle(k, session, issue, nudgeMsg);
              continue;
            } else {
              // AI already replied before dying — no need to nudge, but user must be
              // notified the process terminated so they know the run is over.
              log.info(`engine: process died for ${k} but AI had posted ${aiReplies} reply(ies), not nudging`);
              await tracker.createComment(ref, `[system] 💀 **${session.name}** process exited unexpectedly.`).catch(
                err => log.error(`engine: process-exit comment failed for ${k}:`, (err as Error).message)
              );
            }
          } else {
            log.warn(`engine: process died for ${k}, process-exit nudge exhausted (${exitNudgeRound}/${Engine.MAX_PROCESS_EXIT_NUDGE_ROUNDS}), giving up`);
            await tracker.createComment(ref, `[system] ⛔ **${session.name}** process exited, gave up after ${Engine.MAX_PROCESS_EXIT_NUDGE_ROUNDS} restart attempt(s).`).catch(
              err => log.error(`engine: process-exit comment failed for ${k}:`, (err as Error).message)
            );
            this.processExitNudgeRounds.delete(k);
          }

          // Try to dequeue next message
          const nextMsg = await this.store.getNextPendingMessage(session.id);
          if (nextMsg) {
            await this.dequeueOrIdle(k, session, issue, nextMsg);
          }
          continue;
        }

        // Process alive — check stuck
        if (lastTs && Date.now() - lastTs >= this.stuckThresholdMs) {
          const minutes = Math.round((Date.now() - lastTs) / 60000);
          const ref = this.sessionToRef(session, issue);

          const stuckNudgeRound = this.stuckNudgeRounds.get(k) ?? 0;
          if (stuckNudgeRound < this.maxStuckNudges) {
            log.warn(`engine: stuck — no output for ${minutes}min on ${k}, killing + sending stuck nudge (round ${stuckNudgeRound + 1}/${this.maxStuckNudges})`);
            await tracker.createComment(ref, `[system] ⏰ **${session.name}** no output for ${minutes} min, restarting...`).catch(
              err => log.error(`engine: stuck-nudge comment failed for ${k}:`, (err as Error).message)
            );

            this.forceStop(k);
            this.stuckNudgeRounds.set(k, stuckNudgeRound + 1);

            const instructions = tracker.getTrackerInstructions(ref);
            const nudgePrompt = this.buildStuckNudgePrompt(session, issue, instructions, minutes);
            const nudgeMsg = await this.store.createMessage(session.id, nudgePrompt, undefined, undefined, this.currentModel.get(k));
            await this.dequeueOrIdle(k, session, issue, nudgeMsg);
          } else {
            log.warn(`engine: stuck for ${minutes}min on ${k}, stuck nudge exhausted (${stuckNudgeRound}/${this.maxStuckNudges}), giving up`);
            await tracker.createComment(ref, `[system] ⛔ **${session.name}** stuck for ${minutes} min, gave up after ${this.maxStuckNudges} restart(s).`).catch(
              err => log.error(`engine: stuck-giveup comment failed for ${k}:`, (err as Error).message)
            );
            this.forceStop(k);
            this.stuckNudgeRounds.delete(k);
          }
        }
      } else if (session.state === "running" && !this.running.has(k)) {
        log.warn(`engine: observer fixing orphaned running state for ${k}`);
        this.running.delete(k);
        await this.store.updateSession(session.id, { state: "idle" });
      }
    }

    // Progress reports for running sessions
    const now = Date.now();
    for (const session of sessions) {
      const k = this.sessionKey(session, issue);
      const started = this.startedAt.get(k);
      if (!started || !this.running.has(k)) continue;

      const ref = this.sessionToRef(session, issue);
      const duration = this.formatDuration(now - started);
      const body = `[system] ⏳ **${session.name}** processing, running for ${duration}...`;

      const existingId = this.progressCommentId.get(k);
      try {
        if (existingId) {
          await tracker.editComment(ref, existingId, body);
        } else {
          const result = await tracker.createComment(ref, body);
          this.progressCommentId.set(k, result.id);
          await this.persistRuntimeState(session.id);
        }
      } catch (err) {
        log.error(`engine: progress report failed for ${k}:`, (err as Error).message);
        if (existingId) {
          this.progressCommentId.delete(k);
        }
      }
    }
  }

  // ─── Recovery ───

  private async recover() {
    // Release stale owners first so we can adopt orphaned issues that just
    // became available (this daemon is fresh; any dead daemon's slots are now
    // reclaimable).
    try {
      await this.store.releaseDeadOwners(this.cfg.work.leaseTtlMs);
    } catch (err) {
      log.error("engine: releaseDeadOwners at boot failed:", (err as Error).message);
    }

    await this.cleanupGlobalOrphans();

    // Multi-machine: recover ONLY this daemon's sessions. Other daemons own
    // the rest; touching their state would race them.
    const ownedSessions = await this.store.listOwnedSessions(this.daemonId);

    for (const session of ownedSessions) {
      if (session.opencodePid) {
        try {
          process.kill(session.opencodePid, 0);
          log.info(`engine: SIGTERM to orphaned pid=${session.opencodePid} for session ${session.id}`);
          process.kill(session.opencodePid, "SIGTERM");
          let exited = false;
          for (let i = 0; i < 30; i++) {
            Bun.sleepSync(100);
            try { process.kill(session.opencodePid, 0); } catch { exited = true; break; }
          }
          if (!exited) {
            log.info(`engine: SIGTERM timeout, SIGKILL pid=${session.opencodePid}`);
            try { process.kill(session.opencodePid, "SIGKILL"); } catch { /* dead */ }
          }
        } catch { /* already dead */ }
        await this.store.updateSession(session.id, { opencodePid: undefined });
      }
    }

    // Restore runtime state (now persisted in op_sessions) from DB.
    for (const session of ownedSessions) {
      const issue = await this.store.getIssue(session.issueId);
      if (!issue || issue.state === "closed") continue;
      const k = this.sessionKey(session, issue);
      if (session.startedAt != null) this.startedAt.set(k, session.startedAt);
      if (session.progressCommentId) this.progressCommentId.set(k, session.progressCommentId);
      if (session.currentPrompt) this.currentPrompt.set(k, session.currentPrompt);
      if (session.lastOutputAt != null) this.lastOutputAt.set(k, session.lastOutputAt);
      if (session.nudgeRounds != null) this.nudgeRounds.set(k, session.nudgeRounds);
      if (session.stuckNudgeRounds != null) this.stuckNudgeRounds.set(k, session.stuckNudgeRounds);
      if (session.generation != null) this.generation.set(k, session.generation);
      // Start observer for active issues we own
      this.startObserver(issue);
    }

    const restored = this.startedAt.size;
    if (restored > 0) {
      log.info(`engine: restored runtime state for ${restored} sessions from DB`);
    }

    // Recover stuck messages scoped to this daemon's issues.
    const stuck = await this.store.getOwnedPendingOrRunningMessages(this.daemonId);
    if (stuck.length === 0) return;

    log.info(`engine: recovering ${stuck.length} stuck messages`);

    // Reset running messages to pending
    for (const msg of stuck) {
      if (msg.status === "running") {
        await this.store.updateMessageStatus(msg.id, "interrupted");
      }
    }

    // Group by session and re-run earliest pending
    const bySession = new Map<string, Message[]>();
    for (const msg of stuck) {
      const arr = bySession.get(msg.sessionId) ?? [];
      arr.push(msg);
      bySession.set(msg.sessionId, arr);
    }

    for (const [sessionId, msgs] of bySession) {
      const session = await this.store.getSession(sessionId);
      if (!session) continue;
      const issue = await this.store.getIssue(session.issueId);
      if (!issue || issue.state === "closed") continue;

      const gate = await this.gateChecker(issue);
      if (!gate.allowed) {
        log.info(`engine: recover — web gate blocked ${issue.trackerScopeKey}#${issue.trackerIssueId} (${gate.reason}), discarding queued (pending) messages`);
        for (const m of msgs) {
          if (m.status === "pending") {
            await this.store.updateMessageStatus(m.id, "failed", `web gate: ${gate.reason}`);
          }
        }
        continue;
      }

      const k = this.sessionKey(session, issue);
      if (this.running.has(k)) continue;

      for (const m of msgs) {
        if (m.status === "running") {
          await this.store.updateMessageStatus(m.id, "pending");
        }
      }

      const first = msgs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;

      // Check if AI already replied before the crash — skip re-running if so
      const ref = this.sessionToRef(session, issue);
      const tracker = this.getTracker(issue.trackerType);
      const comments = await tracker.listComments(ref).catch((): TrackerComment[] => []);
      if (this.hasRecentBotReply(comments, tracker)) {
        log.info(`engine: recovered msg ${first.id.slice(0, 8)} for ${k} — bot reply detected, marking done`);
        await this.store.updateMessageStatus(first.id, "done");
        const next = await this.store.getNextPendingMessage(session.id);
        if (next) { await this.dequeueOrIdle(k, session, issue, next); }
        continue;
      }

      log.info(`engine: recovering msg ${first.id.slice(0, 8)} for ${k}`);
      await this.dequeueOrIdle(k, session, issue, first);
    }
  }

  private async cleanupGlobalOrphans(): Promise<void> {
    let sessions: Array<{ id: string; opencodePid: number }>;
    try {
      sessions = await this.store.listSessionsWithPid(this.daemonId);
    } catch { return; }
    const binaryName = this.cfg.opencode.binary.split("/").pop() ?? "opencode";
    let killed = 0;
    for (const s of sessions) {
      let alive = false;
      try { process.kill(s.opencodePid, 0); alive = true; } catch { /* dead */ }
      if (!alive) continue;

      try {
        const cmdline = readFileSync(`/proc/${s.opencodePid}/cmdline`, "utf8");
        const exe = cmdline.split("\0")[0] ?? "";
        const base = exe.split("/").pop() ?? "";
        if (base !== binaryName && base !== "opencode" && base !== "pi") continue;
      } catch { continue; }

      let ppid = -1;
      try {
        const stat = readFileSync(`/proc/${s.opencodePid}/stat`, "utf8");
        const m = stat.match(/\)\s+\S+\s+(\d+)/);
        ppid = m ? Number(m[1]) : -1;
      } catch { continue; }

      if (ppid === 1) {
        log.info(`engine: killing orphaned pid=${s.opencodePid} (PPID=1, session ${s.id})`);
        try { this.killProcessTree(s.opencodePid); } catch { /* dead */ }
        killed++;
      }
    }
    if (killed > 0) log.info(`engine: cleaned up ${killed} orphaned processes (PPID=1)`);
  }

  // ─── API Methods ───

  async retryMessage(messageId: string): Promise<boolean> {
    const msg = await this.store.getMessage(messageId);
    if (!msg || msg.status !== "failed") return false;
    const session = await this.store.getSession(msg.sessionId);
    if (!session) return false;
    const issue = await this.store.getIssue(session.issueId);
    if (!issue || issue.state === "closed") return false;

    await this.store.updateMessageStatus(messageId, "pending");
    const k = this.sessionKey(session, issue);
    if (!this.running.has(k)) {
      await this.dequeueOrIdle(k, session, issue, msg);
    }
    return true;
  }

  async getStatus() {
    const pendingCount = (await this.store.getOwnedPendingOrRunningMessages(this.daemonId)).filter(m => m.status === "pending").length;
    return {
      runningCount: this.running.size,
      runningKeys: [...this.running],
      pendingCount,
      processCount: this.processes.size,
      observedIssues: this.observedIssues.size,
      daemonId: this.daemonId,
    };
  }

  async getQueue(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const allPending = (await this.store.getOwnedPendingOrRunningMessages(this.daemonId)).filter(m => m.status === "pending");
    for (const msg of allPending) {
      const session = await this.store.getSession(msg.sessionId);
      if (!session) continue;
      const issue = await this.store.getIssue(session.issueId);
      if (!issue) continue;
      const k = this.sessionKey(session, issue);
      result[k] = (result[k] ?? 0) + 1;
    }
    return result;
  }

  getProcesses(): Array<{ key: string; pid: number; lastOutputAt: number | null }> {
    const result: Array<{ key: string; pid: number; lastOutputAt: number | null }> = [];
    for (const [k, proc] of this.processes) {
      result.push({
        key: k,
        pid: proc.pid,
        lastOutputAt: this.lastOutputAt.get(k) ?? null,
      });
    }
    return result;
  }

  private killProcessTree(pid: number, signal: NodeJS.Signals | number = 9): void {
    try {
      const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
      const childPids = result.stdout.toString().trim().split("\n").filter(Boolean);
      for (const childPid of childPids) {
        this.killProcessTree(Number(childPid), signal);
      }
    } catch { /* pgrep failed */ }
    try { process.kill(pid, signal); } catch { /* already dead */ }
  }

  async forceStop(key: string): Promise<boolean> {
    const proc = this.processes.get(key);
    this.stopping.add(key);
    log.warn(`engine: forceStop ${key}, pid=${proc?.pid ?? "none"}`);

    if (proc) {
      try { process.kill(proc.pid, 9); } catch { /* dead */ }
      this.processes.delete(key);
    }

    const progressId = this.progressCommentId.get(key);

    this.running.delete(key);
    this.currentMessage.delete(key);
    this.lastOutputAt.delete(key);
    this.startedAt.delete(key);
    this.progressCommentId.delete(key);
    this.currentPrompt.delete(key);
    this.processExitNudgeRounds.delete(key);
    this.stuckNudgeRounds.delete(key);
    this.generation.delete(key);
    // Update session and messages
    const parsed = parseKey(key);
    if (parsed) {
      const issue = await this.store.findIssue(parsed.trackerType, parsed.scopeKey, parsed.issueId);
      if (issue) {
        const session = await this.store.getSessionByName(issue.id, parsed.sessionName);
        if (session) {
          if (progressId) {
            const ref = this.sessionToRef(session, issue);
            const tracker = this.getTracker(issue.trackerType);
            void tracker.editComment(ref, progressId, `[system] ⛔ **${session.name}** force-stopped.`).catch(() => {});
          }
          const msgs = await this.store.getMessagesForSession(session.id);
          for (const msg of msgs) {
            if (msg.status === "pending" || msg.status === "running") {
              await this.store.updateMessageStatus(msg.id, "failed", "force stopped");
            }
          }
          await this.store.updateSession(session.id, {
            state: "idle",
            opencodePid: undefined,
            startedAt: undefined,
            progressCommentId: undefined,
            currentPrompt: undefined,
          });
        }
      }
    }

    return !!proc;
  }

  destroy() {
    this.stopHeartbeat();
    if (this.observerTimer) clearInterval(this.observerTimer);
    this.observedIssues.clear();
    for (const [, proc] of this.processes) {
      try { process.kill(proc.pid, "SIGKILL"); } catch { /* dead */ }
    }
    this.processes.clear();
    this.running.clear();
    this.stopping.clear();
    this.currentMessage.clear();
    this.lastOutputAt.clear();
    this.startedAt.clear();
    this.progressCommentId.clear();
    this.processExitNudgeRounds.clear();
    this.stuckNudgeRounds.clear();
    this.currentPrompt.clear();
    this.generation.clear();
    this.groupConfigs.clear();
    this.cloneUrls.clear();
    this.senders.clear();
    this.emptyResponseRounds.clear();
  }
}
