import {
  type UpstreamSyncRow,
  type ProjectRow,
  type IssueRow,
  getProjectById,
  getIssue,
  getIssueByUpstreamNumber,
  listLabelsForIssue,
  linkIssueToUpstream,
  getCommentByUpstreamId,
  createIssue,
  ensureUser,
  postComment,
  editIssue,
  ensureIssueHasLabel,
  updateIssueAiStatus,
  updateIssueMergeState,
  updateIssueCiState,
  updateIssueChecks,
  updateUpstreamSyncState,
  listEnabledUpstreamSyncs,
  updateIssueConflictState,
  markIssueAnnounced,
  getUnannouncedIssues,
} from "./store";
import { emitIssueEvent, emitCommentEvent, emitMergeConflictEvent, emitCiFailedEvent, emitMasterCiFailedEvent } from "./webhooks";
import { getDB, getConfigAll } from "./db";
import { log } from "./logger";
import type { Config } from "./config";

export interface GiteaIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

interface GiteaComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  issue_url?: string;
}

export interface UpstreamSyncPollResult {
  issuesImported: number;
  issuesUpdated: number;
  commentsImported: number;
}

const GITEA_COMMENT_ISSUE_RE = /\/issues\/(\d+)$/;

// GitHub CI/actions identities end in [bot]; their comments must not wake
// the engine, so they are imported as bot-kind users.
function fromGithubBot(login: string | undefined): boolean {
  return typeof login === "string" && /\[bot\]$/i.test(login.trim());
}

function upstreamIssueNumberFromComment(gc: GiteaComment): number | null {
  const m = (gc.issue_url ?? "").match(GITEA_COMMENT_ISSUE_RE);
  return m ? Number(m[1]) : null;
}

export const MERGE_PROBE_WINDOW_MS = 432_000_000;
export const MERGE_PROBE_PER_POLL = 5;

// PR conflict state only changes when head or base moves, and any move bumps
// the PR's updated_at — so probing only PRs whose updated_at advanced past the
// last probe covers every transition with zero requests for quiet PRs
// (owner policy 2026-10-19: activity window is the trailing 5 days — was 48h;
// older PRs are skipped).
export function mergeProbeCandidates(
  issues: GiteaIssue[],
  checkedAtByNumber: Map<number, string>,
  nowMs: number,
  windowMs: number = MERGE_PROBE_WINDOW_MS,
): number[] {
  const out: number[] = [];
  for (const gi of issues) {
    if (!gi.pull_request || gi.state === "closed") continue;
    const updatedMs = Date.parse(gi.updated_at ?? "");
    if (!Number.isFinite(updatedMs) || nowMs - updatedMs > windowMs) continue;
    const checked = checkedAtByNumber.get(gi.number);
    if (checked && checked >= gi.updated_at) continue;
    out.push(gi.number);
  }
  return out.slice(0, MERGE_PROBE_PER_POLL);
}

interface PullRequestPayload {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head?: { sha?: string | null } | null;
}

interface CheckRunPayload {
  name?: string;
  html_url?: string;
  status?: string;
  conclusion?: string | null;
}

// Per-PR CI-fix bookkeeping (owner policy 2026-10-14): sha tracks the last
// failing head we dispatched for; attempts caps auto-fix cycles at 2 per PR
// so a hopeless CI never loops the worker. Green builds reset the state.
export interface CiProbeState {
  sha: string;
  attempts: number;
}

// Pure transition rule: emit on a NEW failing sha until 2 fix attempts per PR
// are spent; green clears state; same sha never re-emits (loop guard).
export function ciProbeDecision(
  stored: CiProbeState | null,
  sha: string,
  failedCount: number,
): { emit: boolean; next: CiProbeState | null } {
  if (failedCount === 0) return { emit: false, next: null };
  if (stored?.sha === sha) return { emit: false, next: stored };
  if ((stored?.attempts ?? 0) >= 2) return { emit: false, next: stored };
  return { emit: true, next: { sha, attempts: (stored?.attempts ?? 0) + 1 } };
}

export interface GithubDiscussion {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  category?: { name?: string } | null;
}

// Canonical short states: dirty (real conflicts), behind (base moved, clean
// merge expected), clean, pending (GitHub hasn't computed mergeable yet —
// retry next poll). Gitea only exposes the mergeable boolean.
export function prMergeState(pull: PullRequestPayload): string {
  const ms = pull.mergeable_state;
  if (ms === "dirty" || ms === "behind" || ms === "clean") return ms;
  if (typeof pull.mergeable === "boolean") return pull.mergeable ? "clean" : "dirty";
  return "pending";
}

export function syncOrigin(cfg: Config): string {
  const first = cfg.publicOrigins[0];
  if (first) return first.replace(/\/+$/, "");
  return `http://127.0.0.1:${cfg.port}`;
}

function clipTitle(t: string): string {
  // Mirror titles must fit the tracker's 255-char ceiling; a single overlong
  // upstream title otherwise aborts the whole poll batch (observed wedge
  // 2026-10-17: b-c#3476's 355-char title froze the comment stream).
  return t.length > 255 ? t.slice(0, 254) + "…" : t;
}

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff]/;

async function defaultTranslateTitle(raw: string): Promise<string | null> {
  // Ingest-time deterministic rename (owner policy 2026-10-17): CJK upstream
  // titles get an English lead segment at import, composed by the pipeline
  // instead of relying on agents (agent renames drifted in both format and
  // order — b-c#3373 appended the translation at the tail).
  try {
    const proc = Bun.spawn(["ework-translate", raw], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (!line) return null;
    return line.replace(/\s+/g, " ").slice(0, 120);
  } catch {
    return null;
  }
}

let titleTranslator: (raw: string) => Promise<string | null> = defaultTranslateTitle;

export function setTitleTranslator(fn: (raw: string) => Promise<string | null>): void {
  titleTranslator = fn;
}

// Master CI sentinel throttle, process-wide: UpstreamSync instances are
// rebuilt per tick, so per-instance state could not suppress re-emits
// (incident: two master_ci_failed fires 77s apart on first live run
// 2026-10-24). Keyed by project id; web restart re-emits once — bounded by
// the daemon-side sentinel attempt cap.
const masterCiLastEmitByProject = new Map<string, { sha: string; at: number }>();
const mergeGuardCooldownUntil = new Map<number, number>();
// Reprobe drains once per 60s per process — at the 15s poll tick they were
// burning ~2400 req/h against a 5000/h PAT budget (rate exhausted hourly,
// 2026-10-26). Same budget: any 403 from GitHub opens a 5-minute global
// circuit so every project's optional probes stop colliding in the dark.
const reprobeDrainThrottle = { lastAt: 0 };
const githubCircuit = { until: 0 };

// ─── Merge-guard wake-once fingerprints (audit RC1(a)/(c)) ──────────────────
// Emission memory lives in issues.upstream_merge_guard_at as JSON
// ({v:1, cells:{<family>:{at,fp}}}) so a daemon/web restart cannot replay
// yesterday's wakes. A family re-emits ONLY when its fingerprint differs from
// the one last emitted — master forward / new head wakes immediately, and a
// steady state never re-wakes (the old 6h wall-clock re-arm fired up to 4x/day
// per PR even when nothing changed). Legacy cells hold a plain ISO timestamp
// (pre-fingerprint builds): they parse as "no fingerprints known", which costs
// at most one convergence emit per family on the first scan after rollout,
// after which the JSON shape takes over. Corrupt cells reset the same way.
export interface MergeGuardCell { at: number; fp: string }
export interface MergeGuardDoc { v: number; cells: Record<string, MergeGuardCell> }

export function parseMergeGuardDoc(raw: string | null | undefined): MergeGuardDoc {
  const empty: MergeGuardDoc = { v: 1, cells: {} };
  if (!raw) return empty;
  const s = String(raw).trim();
  if (s.startsWith("{")) {
    try {
      const p = JSON.parse(s) as { cells?: unknown };
      if (p && typeof p === "object" && p.cells && typeof p.cells === "object") {
        const cells: Record<string, MergeGuardCell> = {};
        for (const [k, c] of Object.entries(p.cells as Record<string, unknown>)) {
          const cc = c as { at?: unknown; fp?: unknown };
          if (cc && typeof cc === "object" && typeof cc.at === "number" && Number.isFinite(cc.at) && typeof cc.fp === "string") {
            cells[k] = { at: cc.at, fp: cc.fp };
          }
        }
        return { v: 1, cells };
      }
    } catch {
      /* corrupt cell → treat as fresh */
    }
    return empty;
  }
  // Legacy plain-timestamp cell: it records WHEN something was emitted but not
  // WHAT state-shape — with no fingerprint there is nothing to compare against.
  return empty;
}

/** Per-family fingerprint = the state SHAPE, not the wall clock.
 * ci/review keys off the head sha (a new head is the thing that needs a new
 * fix attempt); unmergeable:* keys off base-tip+head so a master forward
 * behind a stable head produces a fresh wake immediately. */
export function guardFingerprint(family: string, headSha: string | undefined, baseSha?: string | undefined): string {
  if (family.startsWith("unmergeable")) return `${baseSha ?? "nb"}:${headSha ?? "nosha"}`;
  return headSha ?? "nosha";
}

export class UpstreamSync {
  private readonly sync: UpstreamSyncRow;
  private readonly project: ProjectRow;
  private readonly origin: string;
  private readonly discussionsEnabled: boolean;
  private readonly issuesEnabled: boolean;
  private readonly discussionWhitelist: string[] | null;
  private readonly titleTranslate: boolean;
  private readonly titleCache = new Map<string, string>();

  constructor(
    sync: UpstreamSyncRow,
    project: ProjectRow,
    origin: string,
    discussionsEnabled = false,
    issuesEnabled = true,
    discussionWhitelist?: string,
    titleTranslate = false,
  ) {
    this.sync = sync;
    this.project = project;
    this.origin = origin;
    const githubUpstream = sync.base_url.toLowerCase().includes("github.com");
    this.discussionsEnabled = discussionsEnabled && githubUpstream;
    this.issuesEnabled = issuesEnabled;
    this.discussionWhitelist = discussionWhitelist
      ? discussionWhitelist.split(",").map((x) => x.trim()).filter(Boolean)
      : null;
    this.titleTranslate = titleTranslate && githubUpstream;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.sync.token) h.Authorization = `token ${this.sync.token}`;
    return h;
  }

  private api(path: string): string {
    const base = /github\.com$/i.test(new URL(this.sync.base_url).host)
        ? "https://api.github.com"
        : this.sync.base_url;
      const prefix = base === "https://api.github.com" ? "" : "/api/v1";
      return `${base}${prefix}/repos/${this.sync.upstream_owner}/${this.sync.upstream_repo}${path}`;
  }

  // Push the composed bilingual title back to the upstream issue so GitHub
  // (what the owner reads) matches the mirror. Best-effort: failures log and
  // skip — the mirror stays authoritative for our own display either way.
  private async patchUpstreamTitle(gi: GiteaIssue, title: string): Promise<void> {
    try {
      const resp = await fetch(this.api(`/issues/${gi.number}`), {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        log.warn("upstream-sync: title write-back failed", { n: gi.number, status: resp.status });
      }
    } catch (err) {
      log.warn("upstream-sync: title write-back error", { n: gi.number, err: String(err) });
    }
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    if (Date.now() < githubCircuit.until) return null;
    const resp = await fetch(this.api(path), { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (resp.status === 404) return null;
    if (resp.status === 403) {
      // Trip the global circuit: every project's probing pauses 5 minutes so
      // optional fetches stop colliding inside the dark window (2026-10-26).
      githubCircuit.until = Math.max(githubCircuit.until, Date.now() + 5 * 60_000);
      throw new Error(`upstream ${path} -> 403 rate-limited (circuit open 5m)`);
    }
    if (!resp.ok) throw new Error(`upstream ${path} -> ${resp.status}`);
    return (await resp.json()) as T;
  }

  // 2026-10-28: GraphQL carries its own 5000-point/h quota, fully separate
  // from the REST core budget the owner capped at 10 req/min. Batch reads
  // (100 PRs of mergeableState per query) ride it instead of REST fan-outs.
  private async fetchGql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    if (Date.now() < githubCircuit.until) return null;
    const base = /github\.com$/i.test(new URL(this.sync.base_url).host)
      ? "https://api.github.com"
      : this.sync.base_url;
    let resp: Response;
    try {
      resp = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
    if (!resp.ok) {
      log.warn(`upstream-sync: graphql http ${resp.status} (guard pass skipped)`);
      return null;
    }
    try {
      const body = (await resp.json()) as { data?: T; errors?: unknown[] };
      if (body.errors?.length) {
        // A malformed query fails HERE every pass — surfacing it beats the
        // silent 26h guard blackout of 2026-10-28/29 (mergeableState typo).
        log.warn(`upstream-sync: graphql errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
        return null;
      }
      return body.data ?? null;
    } catch {
      return null;
    }
  }

  // First run (null issue cursor) is a backfill: import open issues + their
  // comments silently so the AI isn't woken by a flood of historical entries.
  // Live polls (cursor set) emit webhooks so new upstream activity reaches
  // the daemon exactly like locally-created content.
  private get isGithub(): boolean {
    try {
      return /github\.com$/i.test(new URL(this.sync.base_url).host);
    } catch {
      return false;
    }
  }

  private get isBackfill(): boolean {
    return this.sync.issue_cursor === null;
  }

  // The pipeline PATCHes composed titles back upstream, so a later poll can
  // see its own output as input. composeTitle must therefore be idempotent:
  //  - strip repeated "[PR] " leads (else every cycle prepends another one —
  //    the billion-context#3623 title storm, 2026-10-17);
  //  - recognize an already-bilingual "EN | 原题" lead and reuse it instead of
  //    re-translating the whole string (which would double the lead).
  private static stripPrLeads(t: string): string {
    return t.replace(/^(\[PR\] )+/g, "");
  }

  private async composeTitle(rawTitle: string | undefined, isPr: boolean, number: number): Promise<string> {
    const stripped = UpstreamSync.stripPrLeads(rawTitle || `#${number}`);
    const prefix = isPr ? "[PR] " : "";
    if (!this.titleTranslate || !CJK_RE.test(stripped)) return clipTitle(prefix + stripped);
    const composed = stripped.match(/^(.*?) \| ([^|]*)$/);
    const lead = composed?.[1];
    const tail = composed?.[2];
    if (lead !== undefined && tail !== undefined && CJK_RE.test(lead) && !CJK_RE.test(tail) && tail.trim().length > 8) {
      // Agent-mangled "CJK | EN" (English appended at the tail): normalize to
      // the canonical "EN | CJK" shape by reusing the tail. Never translate
      // the whole string here — a translator echo would duplicate the title
      // on every poll (incident 2026-10-19 #3842).
      return clipTitle(prefix + tail.trim() + " | " + lead.trim());
    }
    const raw = tail !== undefined && CJK_RE.test(tail) ? tail : stripped;
    const cachedEn = lead ?? this.titleCache.get(raw);
    let en = cachedEn;
    if (en === undefined) {
      en = (await titleTranslator(raw)) ?? "";
      this.titleCache.set(raw, en);
    }
    // Echo guard: a "translation" that is still CJK (or identical to raw)
    // must not be composed — `${en} | ${raw}` would then duplicate the title
    // each poll cycle (incident 2026-10-19 #3842).
    if (!en || en === raw || CJK_RE.test(en)) return clipTitle(prefix + raw);
    return clipTitle(prefix + en + " | " + raw);
  }

  private async importIssue(gi: GiteaIssue, emit: boolean): Promise<void> {
    const body = gi.body ?? "";
    // Issues ework-mirror created upstream reference their origin issue by
    // number in the footer. Linking instead of importing prevents the echo
    // loop (local → mirror → GitHub → poll → twin) while keeping comment and
    // state sync flowing to the original.
    const mirrored = body.includes("<!-- ework-mirror -->")
      ? body.match(/Mirrored from ework issue #(\d+)/)
      : null;
    if (mirrored?.[1]) {
      const origin = await getIssue(this.project.id, Number(mirrored[1]));
      if (origin) {
        await linkIssueToUpstream(origin.id, gi.number);
        return;
      }
    }
    if (body.includes("<!-- ework-mirror -->")) return;
    await ensureUser(gi.user?.login ?? "upstream", fromGithubBot(gi.user?.login) ? "bot" : "human");
    const composedImportTitle = await this.composeTitle(gi.title, !!gi.pull_request, gi.number);
    await createIssue(
      this.project.id,
      composedImportTitle,
      gi.body ?? "",
      gi.user?.login ?? "upstream",
      {
        createdAt: gi.created_at,
        updatedAt: gi.updated_at,
        state: gi.state === "closed" ? "closed" : "open",
        upstreamIssueNumber: gi.number,
        number: gi.number,
      }
    );
    // Always announce imported PRs, including ones carrying the
    // ework-agent-pr marker. The marker used to silence the opened event as
    // an anti-feedback-loop guard, but agents open PRs with the same GitHub
    // login as the human owner, so a body marker cannot attribute
    // authorship: it silently ate PRs the owner opened themselves (or via an
    // agent-prepared body). Self-recognition now lives at the session level
    // (AGENTS.md: marker-PR = verify + report, don't redo).
    const created = await getIssueByUpstreamNumber(this.project.id, gi.number);
    if (this.titleTranslate && composedImportTitle !== gi.title) {
      await this.patchUpstreamTitle(gi, composedImportTitle);
    }
    if (gi.pull_request && created) {
      await ensureIssueHasLabel(this.project.id, created.id, "pr", "#576699");
    }
    if (created) {
      if (emit) void emitIssueEvent(this.project.id, created.id, "opened", this.origin);
      // Crawl imports (emit=false) count as announced-by-history — sweeping
      // thousands of historical rows would storm the daemon.
      void markIssueAnnounced(created.id);
    } else {
      log.error(`upstream-sync: import of #${gi.number} lost its row after create — sweep will re-emit`);
    }
  }

  private async syncIssueState(existing: IssueRow, gi: GiteaIssue, emit: boolean): Promise<boolean> {
    const target: "open" | "closed" = gi.state === "closed" ? "closed" : "open";
    if (existing.state === target) return false;
    await editIssue(existing.id, { state: target });
    // stale AI badges on closed rows read as noise on the issue list
    if (target === "closed" && existing.ai_status && existing.ai_status !== "completed") {
      await updateIssueAiStatus(existing.id, "");
    }
    if (emit) {
      void emitIssueEvent(this.project.id, existing.id, target === "closed" ? "closed" : "reopened", this.origin);
    }
    return true;
  }

  private async probeMergeState(gi: GiteaIssue, existing: IssueRow, result: UpstreamSyncPollResult): Promise<void> {
    const pull = await this.fetchJson<PullRequestPayload>(`/pulls/${gi.number}`);
    if (!pull) return;
    const state = prMergeState(pull);
    // pending: GitHub hasn't computed mergeable yet — leave checked_at behind
    // so the next poll retries the probe.
    if (state === "pending") return;
    await this.applyMergeState(existing, state, result, gi.updated_at ?? new Date().toISOString());
  }

  private async applyMergeState(
    existing: IssueRow,
    state: string,
    result: UpstreamSyncPollResult,
    updatedAtIso?: string,
  ): Promise<void> {
    const was = existing.upstream_mergeable_state;
    await updateIssueMergeState(existing.id, state, updatedAtIso ?? new Date().toISOString());
    if (state === "dirty") {
      // One-shot transition emission loses conflicts whose single event died in
      // an outage window — the row then sticks at dirty forever (PR#3873 sat
      // conflicted for a day with zero dispatch). Re-arm: while the conflict
      // persists, re-emit every 6h until the state turns clean.
      let lastEmit: number | null = null;
      try {
        lastEmit = existing.upstream_conflict_state
          ? (JSON.parse(existing.upstream_conflict_state) as { lastEmit: number }).lastEmit
          : null;
      } catch {
        lastEmit = null;
      }
      const REARM_MS = 6 * 60 * 60 * 1000;
      if (was !== "dirty" || lastEmit === null || Date.now() - lastEmit > REARM_MS) {
        log.info(`upstream-sync: merge conflict detected on upstream PR #${existing.upstream_issue_number} (${this.project.owner}/${this.project.name})`);
        await emitMergeConflictEvent(this.project.id, existing.id, this.origin, state);
        await updateIssueConflictState(existing.id, JSON.stringify({ lastEmit: Date.now() }));
        result.issuesUpdated++;
      }
    } else if (existing.upstream_conflict_state) {
      await updateIssueConflictState(existing.id, null);
    }
  }

  // CI-failure wake (owner policy 2026-10-14): probe check-runs for the PR's
  // head sha; on a NEW failing sha (max 2 auto-fix attempts per PR) emit a
  // ci_failed event so the daemon routes a sticky ci-worker at it. Conflicts
  // got their auto lane first; CI failures now have one too.
  // Master CI sentinel throttle state (owner directive 2026-10-24): emit once
  // per failing master sha, re-arm after 6h so a still-red master gets
  // re-attempted. In-memory only — a web restart re-emits once, bounded by
  // the daemon-side sentinel attempt cap.
  // Test-visible view of the MASTER branch throttle state (key `${id}:master`).
  private get masterCiLastEmit(): { sha: string; at: number } | null { return masterCiLastEmitByProject.get(`${this.project.id}:master`) ?? null; }
  private set masterCiLastEmit(v: { sha: string; at: number } | null) { if (v) masterCiLastEmitByProject.set(`${this.project.id}:master`, v); else masterCiLastEmitByProject.delete(`${this.project.id}:master`); }

  // Master-branch CI sentinel (owner directive 2026-10-24): master redness is
  // inherited by every PR stacked on it — one fix greens the fleet after a
  // rebase. Enabled per project via the ciSentinelIssue:<owner>/<repo> config
  // key pointing at the CI coordination issue; the event binds to that issue
  // so the sentinel's fix report lands where every agent reads status.
  // (owner incident 2026-10-26 #4801): conflicts arrive via BASE movement, but
  // probe eligibility keyed on PR-side activity meant a quiet PR that went
  // dirty after a master merge was never re-probed (checked>=updated skip
  // held forever). Track the master head; on movement, clear merge-probe
  // bookkeeping so every open PR re-probes over the next polls.
  private lastMasterHead: string | null = null;
  // Quiet PRs never re-enter the changed-item stream, so bookkeeping alone
  // cannot reach them: master movement also enqueues every open PR for a
  // direct merge-state re-probe, drained a few per poll.
  private mergeReprobeQueue: number[] = [];
  // CI completion has the same quiet-PR blind spot as merge state: GitHub's
  // PR updated_at does not change when check-runs complete, so a PR leaves
  // the changed-item stream while its suite is still running (suites take
  // 6-30+ min under queue congestion). PRs whose suite is not yet complete
  // are parked here and re-probed directly until completion, or the red
  // would never emit (PR#4794 class: kernel-guard red, zero dispatch rows,
  // empty upstream_ci_state forever — owner report 2026-10-26).
  private ciReprobeQueue: number[] = [];

  // Truth-driven merge guard (owner directive 2026-10-26): wake criterion is
  // GitHub ground truth — every open PR's mergeable_state — not events. Runs
  // every 8th poll tick (~2 min), scans PRs updated within 72h, and emits
  // pr_unmergeable on a bad-state transition (re-arm 6h while it persists).
  // dirty→conflict, behind→needs-master-sync, blocked+red→CI fix; blocked
  // with green checks = review pending (human state, never wakes).
  private mergeGuardTick = 0;
  // Per-PR guard doc cache over issues.upstream_merge_guard_at (see
  // parseMergeGuardDoc). issueId 0 = PR has no mirrored row (emit skipped).
  private mergeGuardDocs = new Map<number, { issueId: number; doc: MergeGuardDoc }>();

  private async pollMergeGuard(): Promise<void> {
    this.mergeGuardTick++;
      if (this.mergeGuardTick % 2 !== 1) return;
    // Rate-limit cooldown: a 403 during a scan means the PAT budget is gone —
    // hammering every 4 min keeps every project's sync dark (2026-10-26
    // incident: guard scans alone pushed the shared budget over).
    const cd = mergeGuardCooldownUntil.get(this.project.id);
    if (cd && Date.now() < cd) return;
    try {
      await this.pollMergeGuardInner();
    } catch (err: any) {
      if (String(err?.message ?? err).includes("403")) {
        mergeGuardCooldownUntil.set(this.project.id, Date.now() + 30 * 60_000);
        log.warn(`upstream-sync: merge-guard hit 403 — cooling down 30min for ${this.project.owner}/${this.project.name}`);
      }
      log.warn(`upstream-sync: merge-guard scan failed: ${String(err)}`);
    }
  }

  private async pollMergeGuardInner(): Promise<void> {
    // Cheap local gate: no open mirrored PRs = no scan (one SQL, zero API).
    // The /pulls list endpoint returns mergeable_state=null for every row
    // (lazy compute never runs on lists — verified 2026-10-26: 30/30 null,
    // while each /pulls/{n} GET returned real states). Guard therefore
    // deep-GETs a rotating slice of local candidates: 10 per pass ≈ 150 req/h,
    // full 60-PR coverage every ~24 min.
    const rows = await getDB().all(
      // All open PRs, not top-60-by-updated_at: a base-side merge dirties a
      // PR WITHOUT touching its updated_at, so quiet PRs fall out of a
      // recency window and their red state goes unwatched (#4790 sat dirty
      // 20h because overnight activity pushed it past LIMIT 60 — 2026-10-27).
      // Cursor rotation covers the full set at the same 10-probe/pass budget.
      "SELECT upstream_issue_number n FROM issues WHERE project_id = ? AND state = 'open' AND kind = 'issue' AND title LIKE '[PR]%' AND upstream_issue_number IS NOT NULL ORDER BY updated_at DESC",
      [this.project.id],
    );
    const candidates = (rows as { n?: number | string }[]).map((r) => Number(r?.n)).filter((n) => Number.isInteger(n) && n > 0);
    if (candidates.length === 0) return;
    // 2026-10-28: the REST fan-out (16 per-PR GETs × 6 projects per pass)
    // alone burned ~24 req/min against the owner's 10 req/min ceiling.
    // GraphQL batches 100 PRs of mergeableState per query on its separate
    // 5000-point/h quota, so the guard now reads ALL open PRs per pass.
    const pulls: { number?: number; updated_at?: string; mergeable_state?: string; head?: { sha?: string }; base?: { sha?: string } }[] = [];
    let endCursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      type GqlPulls = {
        repository?: {
        pullRequests?: {
          pageInfo?: { endCursor?: string; hasNextPage?: boolean };
          // GraphQL field is mergeStateStatus (BEHIND/BLOCKED/CLEAN/DIRTY) —
          // REST's mergeable_state maps to it; `mergeableState` doesn't exist
          // in the GraphQL schema (26h guard-blind window 2026-10-28/29).
          nodes?: { number: number; updatedAt: string; mergeStateStatus?: string; headRefOid?: string; baseRefOid?: string }[];
        };
        };
      };
      const data: GqlPulls | null = await this.fetchGql<GqlPulls>(
        `query($o: String!, $r: String!, $end: String) { repository(owner: $o, name: $r) { pullRequests(first: 100, states: OPEN, after: $end) { pageInfo { endCursor hasNextPage } nodes { number updatedAt mergeStateStatus headRefOid baseRefOid } } } }`,
        { o: this.sync?.upstream_owner ?? this.project.owner, r: this.sync?.upstream_repo ?? this.project.name, end: endCursor },
      );
      type PullConn = NonNullable<NonNullable<GqlPulls["repository"]>["pullRequests"]>;
      const conn: PullConn | undefined = data?.repository?.pullRequests;
      for (const node of conn?.nodes ?? []) {
        pulls.push({
          number: node.number,
          updated_at: node.updatedAt,
          mergeable_state: String(node.mergeStateStatus ?? "").toLowerCase(),
          head: node.headRefOid ? { sha: node.headRefOid } : undefined,
          base: node.baseRefOid ? { sha: node.baseRefOid } : undefined,
        });
      }
      endCursor = conn?.pageInfo?.endCursor ?? null;
      if (!conn?.pageInfo?.hasNextPage) break;
    }
    const horizon = Date.now() - 72 * 3600_000;
    let bad = 0;
    for (const pr of pulls) {
      try {
        const n = Number(pr?.number);
        const updatedMs = pr?.updated_at ? Date.parse(pr.updated_at) : 0;
        const state = String(pr?.mergeable_state ?? "");
        if (!Number.isInteger(n) || n <= 0 || updatedMs < horizon) continue;
        let reason = "";
        const headSha = pr.head?.sha;
        if (state === "dirty") reason = "conflict";
        else if (state === "behind") reason = "behind";
        else if (state === "blocked") {
          // Truth-driven wake covers ALL unmergeable states (owner directive
          // 2026-10-26). "blocked" mixes review-pending (green checks — review
          // lane) with red checks (ci lane). One extra check-runs GET per
          // blocked PR — now gated on fingerprint movement instead of the 6h
          // wall clock (RC1): a steady-state blocked PR costs ZERO requests,
          // while a new head sha re-probes immediately (the 2026-10-28 rate-
          // budget incident made unconditional per-pass probes unaffordable).
          if (headSha) {
            try {
              const e = await this.ensureMergeGuardDoc(n);
              const ciMoved = e.doc.cells["ci"]?.fp !== headSha;
              const rvMoved = e.doc.cells["review"]?.fp !== headSha;
              if (ciMoved || rvMoved) {
                const cr = await this.fetchJson<{ total_count?: number; check_runs?: { status?: string; conclusion?: string }[] } | null>(
                  `/commits/${headSha}/check-runs`,
                );
                const runs = cr?.check_runs ?? [];
                const allDone = runs.length > 0 && runs.every((r) => r.status === "completed");
                const anyFail = runs.some((r) => r.conclusion === "failure");
                if (allDone && anyFail && ciMoved && e.issueId) {
                  const issueId = e.issueId;
                  await this.tryEmitMergeGuard(e, "ci", headSha, async () => {
                    const { emitCiFailedEvent } = await import("./webhooks");
                    await emitCiFailedEvent(
                      this.project.id,
                      issueId,
                      this.origin,
                      headSha,
                      runs
                        .filter((r) => r.conclusion === "failure")
                        .map((r) => ({ name: String((r as { name?: string }).name ?? "check"), html_url: String((r as { html_url?: string }).html_url ?? ""), conclusion: "failure" })),
                    );
                  });
                  bad++;
                } else if (allDone && !anyFail && rvMoved && e.issueId) {
                  // Green blocked = checks pass but the PR awaits review.
                  // Owner directive 2026-10-28: reviews are fleet work too —
                  // emit review_pending so the review lane picks it up
                  // (#4982 sat "awaiting review" a full night with nobody
                  // watching).
                  const issueId = e.issueId;
                  await this.tryEmitMergeGuard(e, "review", headSha, async () => {
                    const { emitPrReviewPendingEvent } = await import("./webhooks");
                    await emitPrReviewPendingEvent(this.project.id, issueId, this.origin ?? "http://upstream.invalid", headSha);
                    log.info(`upstream-sync: merge guard — PR#${n} blocked+green (review pending) emitted`);
                  });
                }
              }
            } catch {
              // check-runes failure must not abort the pass
            }
          }
          continue;
        }
        if (!reason) continue;
        const e = await this.ensureMergeGuardDoc(n);
        const family = `unmergeable:${state}`;
        const fp = guardFingerprint(family, headSha, pr.base?.sha);
        if (!e.issueId || e.doc.cells[family]?.fp === fp) continue;
        const issueId = e.issueId;
        await this.tryEmitMergeGuard(e, family, fp, async () => {
          const { emitPrUnmergeableEvent } = await import("./webhooks");
          await emitPrUnmergeableEvent(this.project.id, issueId, this.origin ?? "http://upstream.invalid", state, reason);
          log.info(
            `upstream-sync: merge guard — PR#${n} ${state} (${reason}) emitted`,
          );
        });
      } catch (err) {
        log.warn(`upstream-sync: merge-guard item failed for PR#${pr?.number}: ${String(err)}`);
      }
    }
    bad += pulls.filter((p) => p?.mergeable_state === "dirty" || p?.mergeable_state === "behind").length;
    if (bad > 0) log.info(`upstream-sync: merge guard scan: ${pulls.length} scanned, ${bad} bad`);
  }

  /** Lazy per-PR seed of the guard doc cache from issues.upstream_merge_guard_at
   * (one SELECT per PR per process life, not per pass). */
  private async ensureMergeGuardDoc(n: number): Promise<{ issueId: number; doc: MergeGuardDoc }> {
    let e = this.mergeGuardDocs.get(n);
    if (!e) {
      let issueId = 0;
      let raw: string | null = null;
      const row = await getDB().get<{ id: number; cell: string | null }>(
        "SELECT id, upstream_merge_guard_at AS cell FROM issues WHERE project_id = ? AND upstream_issue_number = ? LIMIT 1",
        [this.project.id, n],
      );
      if (row) {
        issueId = row.id;
        raw = row.cell;
      }
      e = { issueId, doc: parseMergeGuardDoc(raw) };
      this.mergeGuardDocs.set(n, e);
    }
    return e;
  }

  /** Fingerprint-gated emit (RC1): fires iff this family's last-emitted
   * fingerprint differs from fp (or none was ever recorded), persists the new
   * cell BEFORE emitting so a crash cannot double-wake, then runs emitFn.
   * Returns whether it emitted. */
  private async tryEmitMergeGuard(
    e: { issueId: number; doc: MergeGuardDoc },
    family: string,
    fp: string,
    emitFn: () => Promise<void>,
  ): Promise<boolean> {
    const cell = e.doc.cells[family];
    if (cell && cell.fp === fp) return false;
    const at = Date.now();
    e.doc.cells[family] = { at, fp };
    if (e.issueId) {
      try {
        await getDB().run(
          "UPDATE issues SET upstream_merge_guard_at = ? WHERE id = ?",
          [JSON.stringify(e.doc), e.issueId],
        );
      } catch (err) {
        log.warn(`upstream-sync: merge-guard persist failed: ${String(err)}`);
      }
    }
    await emitFn();
    return true;
  }

  private async clearMergeProbesIfMasterMoved(): Promise<void> {
    try {
      const headCommit = await this.fetchJson<{ sha?: string } | null>(`/commits/master?per_page=1`);
      const headSha = Array.isArray(headCommit)
        ? (headCommit[0] as { sha?: string })?.sha
        : headCommit?.sha;
      if (!headSha) return;
      if (this.lastMasterHead !== null && headSha !== this.lastMasterHead) {
        await getDB().run(
          "UPDATE issues SET upstream_merge_checked_at = NULL WHERE project_id = ? AND state = 'open'",
          [this.project.id],
        );
        const pulls = await this.fetchJson<{ number?: number }[] | null>(`/pulls?state=open&per_page=100`);
        const queued = (Array.isArray(pulls) ? pulls : [])
          .map((p) => Number(p?.number))
          .filter((n) => Number.isInteger(n) && n > 0 && !this.mergeReprobeQueue.includes(n));
        this.mergeReprobeQueue.push(...queued);
        log.info(
          `upstream-sync: master head moved ${this.lastMasterHead.slice(0, 8)}→${headSha.slice(0, 8)} — merge-probe bookkeeping cleared, ${queued.length} open PR(s) queued for re-probe`,
        );
      }
      this.lastMasterHead = headSha;
    } catch {
      // head probe is an optimization; a failure must never wedge the poll
    }
  }

  private async drainMergeReprobe(result: UpstreamSyncPollResult): Promise<void> {
    let budget = MERGE_PROBE_PER_POLL;
    while (budget > 0 && this.mergeReprobeQueue.length > 0) {
      const number = this.mergeReprobeQueue.shift() as number;
      try {
        const existing = await getDB().get<IssueRow>(
          "SELECT * FROM issues WHERE project_id = ? AND upstream_issue_number = ? AND state = 'open' LIMIT 1",
          [this.project.id, number],
        );
        if (!existing) continue;
        const pull = await this.fetchJson<PullRequestPayload>(`/pulls/${number}`);
        if (!pull) continue;
        const state = prMergeState(pull);
        // pending = GitHub still computing; re-queue once for a later poll
        if (state === "pending") {
          if (!this.mergeReprobeQueue.includes(number)) this.mergeReprobeQueue.push(number);
          continue;
        }
        await this.applyMergeState(existing, state, result);
      } catch (err) {
        log.warn(`upstream-sync: merge re-probe failed for PR #${number}: ${String(err)}`);
      }
      budget--;
    }
  }

  private async probeMasterCi(result: UpstreamSyncPollResult): Promise<void> {
    if (!this.isGithub) return;
    try {
      const scopeKey = `${this.project.owner}/${this.project.name}`;
      const cfg = await getConfigAll();
      const coordNumber = Number(cfg[`ciSentinelIssue:${scopeKey}`] ?? "");
      if (!Number.isInteger(coordNumber) || coordNumber <= 0) return;
      const coordRow = await getDB().get<{ id: number; state: string }>(
        "SELECT id, state FROM issues WHERE project_id = ? AND upstream_issue_number = ? AND kind = 'issue' LIMIT 1",
        [this.project.id, coordNumber],
      );
      if (!coordRow || coordRow.state !== "open") return;
      // (owner directive 2026-10-26): the sentinel also watches the persistent
      // ci-fixes branch itself — its reds previously fell between the master
      // sentinel and the per-PR ci lanes (PR#4727 sat red for hours with no
      // watcher, incident 2026-10-26 01:14). A missing ci-fixes branch (other
      // projects) reads as fetchJson 404→null and skips silently. Throttle
      // state is keyed per project+branch.
      for (const branch of ["master", "ci-fixes"]) {
        const commit = await this.fetchJson<{ sha?: string } | null>(`/commits/${branch}?per_page=1`);
        const sha = Array.isArray(commit) ? (commit[0] as { sha?: string })?.sha : commit?.sha;
        if (!sha) continue;
        const checksResp = await this.fetchJson<CheckRunPayload[] | { check_runs?: CheckRunPayload[] }>(`/commits/${sha}/check-runs?filter=latest`);
        if (!checksResp) continue;
        const checks: CheckRunPayload[] = Array.isArray(checksResp) ? checksResp : (checksResp.check_runs ?? []);
        const allCompleted = checks.length > 0 && checks.every((c: CheckRunPayload) => c.status === "completed");
        if (!allCompleted) continue;
        const failed = checks.filter((c: CheckRunPayload) => c.conclusion === "failure");
        const throttleKey = `${this.project.id}:${branch}`;
        if (failed.length === 0) {
          if (branch === "master") this.masterCiLastEmit = null;
          else masterCiLastEmitByProject.delete(throttleKey);
          continue;
        }
        const REARM_MS = 6 * 60 * 60 * 1000;
        const last = branch === "master" ? this.masterCiLastEmit : (masterCiLastEmitByProject.get(throttleKey) ?? null);
        if (last && last.sha === sha && Date.now() - last.at <= REARM_MS) continue;
        log.info(`upstream-sync: ${branch} branch CI failure detected on ${scopeKey}@${sha.slice(0, 10)} — dispatching sentinel`);
        await emitMasterCiFailedEvent(
          this.project.id,
          coordRow.id,
          this.origin,
          sha,
          failed.map((c) => ({ name: c.name ?? "check", html_url: c.html_url ?? "", conclusion: "failure" })),
          branch,
        );
        if (branch === "master") this.masterCiLastEmit = { sha, at: Date.now() };
        else masterCiLastEmitByProject.set(throttleKey, { sha, at: Date.now() });
        result.issuesUpdated++;
      }
    } catch (err) {
      log.warn(`upstream-sync: master CI probe skipped for ${this.project.owner}/${this.project.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async probeCiState(gi: GiteaIssue, existing: IssueRow, result: UpstreamSyncPollResult): Promise<void> {
    if (!this.isGithub || existing.kind !== "issue" || !(existing.title ?? "").startsWith("[PR]")) return;
    const stillRunning = await this.applyCiState(gi.number, existing, result);
    if (stillRunning && !this.ciReprobeQueue.includes(gi.number)) this.ciReprobeQueue.push(gi.number);
  }

  private async applyCiState(number: number, existing: IssueRow, result: UpstreamSyncPollResult): Promise<boolean> {
    // CI probing is auxiliary telemetry: any failure here (network, API shape
    // surprises, timeouts) must never abort the whole poll — the sync lanes
    // are the primary payload (incident 2026-10-20: checks.filter TypeError
    // killed every b-c poll for an hour).
    try {
    const pull = await this.fetchJson<PullRequestPayload>(`/pulls/${number}`);
    const sha = pull?.head?.sha ?? null;
    if (!sha) return false;
    const checksResp = await this.fetchJson<CheckRunPayload[] | { check_runs?: CheckRunPayload[] }>(`/commits/${sha}/check-runs?filter=latest`);
    if (!checksResp) return false;
    // The check-runs endpoint wraps the list in {total_count, check_runs};
    // tolerate both shapes.
    const checks: CheckRunPayload[] = Array.isArray(checksResp) ? checksResp : (checksResp.check_runs ?? []);
    // Global check cache (owner directive 2026-10-27): the mirror is the single
    // GitHub poller — workers read the cached snapshot via /api/v1/upstream-checks
    // instead of each running gh checks (N workers × polling exhausted the shared
    // 5000/h PAT budget; one poller, everyone caches off it). Best-effort.
    try {
      const snap = {
        fetched_at: new Date().toISOString(),
        sha,
        mergeable_state: (pull as { mergeable_state?: string | null }).mergeable_state ?? null,
        checks: checks.slice(0, 40).map((c: CheckRunPayload) => ({
          name: c.name ?? "check",
          status: c.status ?? null,
          conclusion: c.conclusion ?? null,
          html_url: c.html_url ?? "",
        })),
      };
      await updateIssueChecks(existing.id, JSON.stringify(snap));
    } catch { /* cache write is best-effort telemetry */ }
    // In-progress runs have conclusion=null and must read as NEITHER green nor
    // red — deciding here green-resets the attempt state, re-arming emission
    // for the same logical failure after CI re-runs a superseded head
    // (PR#3886 duplicate dispatch 2026-10-20). Wait for completion instead.
    const allCompleted =
      checks.length > 0 && checks.every((c: CheckRunPayload) => c.status === "completed");
    if (!allCompleted) return true;
    const failed = checks.filter((c: CheckRunPayload) => c.conclusion === "failure");
    if (failed.length === 0) {
      if (existing.upstream_ci_state) await updateIssueCiState(existing.id, null);
      return false;
    }
    let stored: CiProbeState | null = null;
    try {
      stored = existing.upstream_ci_state ? (JSON.parse(existing.upstream_ci_state) as CiProbeState) : null;
    } catch {
      stored = null;
    }
    const decision = ciProbeDecision(stored, sha, failed.length);
    if (!decision.emit) {
      if (decision.next !== stored) await updateIssueCiState(existing.id, decision.next ? JSON.stringify(decision.next) : null);
      return false;
    }
    log.info(`upstream-sync: CI failure detected on upstream PR #${number} (${this.project.owner}/${this.project.name})`);
    await emitCiFailedEvent(
      this.project.id,
      existing.id,
      this.origin,
      sha,
      failed.map((c) => ({ name: c.name ?? "check", html_url: c.html_url ?? "", conclusion: "failure" })),
    );
    await updateIssueCiState(existing.id, decision.next ? JSON.stringify(decision.next satisfies CiProbeState) : null);
    result.issuesUpdated++;
    return false;
    } catch (err) {
      log.warn(`upstream-sync: CI probe skipped for PR #${number} (${this.project.owner}/${this.project.name}): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async drainCiReprobe(result: UpstreamSyncPollResult): Promise<void> {
    let budget = MERGE_PROBE_PER_POLL;
    while (budget > 0 && this.ciReprobeQueue.length > 0) {
      const number = this.ciReprobeQueue.shift() as number;
      try {
        const existing = await getDB().get<IssueRow>(
          "SELECT * FROM issues WHERE project_id = ? AND upstream_issue_number = ? AND state = 'open' LIMIT 1",
          [this.project.id, number],
        );
        if (!existing || existing.kind !== "issue" || !existing.title.startsWith("[PR]")) continue;
        const stillRunning = await this.applyCiState(number, existing, result);
        if (stillRunning) {
          if (!this.ciReprobeQueue.includes(number)) this.ciReprobeQueue.push(number);
          budget--;
          continue;
        }
        budget--;
      } catch (err) {
        budget--;
        log.warn(`upstream-sync: CI re-probe failed for PR #${number}: ${String(err)}`);
      }
    }
  }

  private async importIssueComments(gi: GiteaIssue, emit: boolean): Promise<number> {
    const comments = await this.fetchJson<GiteaComment[]>(this.isGithub
      ? `/issues/${gi.number}/comments?per_page=50`
      : `/issues/${gi.number}/comments?limit=50&order=asc`);
    if (!comments) return 0;
    const local = await getIssueByUpstreamNumber(this.project.id, gi.number);
    if (!local) return 0;
    let n = 0;
    for (const gc of comments) {
      if (await getCommentByUpstreamId(gc.id)) continue;
      // write-back comments carry this marker; importing them would duplicate locally
      if ((gc.body ?? "").includes("<!-- ework-mirror -->")) continue;
      const gcAuthor = gc.user?.login ?? "upstream";
      // ensure the kind before postComment's internal user creation runs
      await ensureUser(gcAuthor, fromGithubBot(gcAuthor) ? "bot" : "human");
      // invisible provenance marker: ework-mirror skips events carrying it, so
      // synced-in comments never echo back to the upstream thread
      const body = (gc.body ?? "") + "\n\n<!-- upstream-sync -->";
      const row = await postComment(local.id, body, gcAuthor, {
        createdAt: gc.created_at,
        updatedAt: gc.updated_at,
        upstreamCommentId: gc.id,
      });
      if (emit) void emitCommentEvent(this.project.id, local.id, row.id, this.origin);
      n++;
    }
    return n;
  }

  private async backfillOnce(): Promise<UpstreamSyncPollResult> {
    const result: UpstreamSyncPollResult = { issuesImported: 0, issuesUpdated: 0, commentsImported: 0 };
    let cursor: string | null = null;
    for (let page = 1; page <= 20; page++) {
      const issues = await this.fetchJson<GiteaIssue[]>(
        this.isGithub
          ? `/issues?state=all&per_page=50&page=${page}&sort=created&direction=asc`
          : `/issues?state=all&type=issues&limit=50&page=${page}&sort=created&order=asc`
      );
      if (!issues || issues.length === 0) break;
      for (const gi of issues) {
        try {
          if (!(await getIssueByUpstreamNumber(this.project.id, gi.number))) {
            await this.importIssue(gi, false);
            result.issuesImported++;
          }
          result.commentsImported += await this.importIssueComments(gi, false);
          if (gi.updated_at && (!cursor || gi.updated_at > cursor)) cursor = gi.updated_at;
        } catch (err) {
          log.warn(`upstream-sync: backfill item failed for #${gi.number}: ${String(err)} — skipping` + (process.env.MIG_DEBUG ? " STACK:" + String((err as any)?.stack ?? "") + " DDL:" + JSON.stringify(await getDB().all("SELECT name, sql FROM sqlite_master WHERE name IN ('issues','users')")) : ""));
        }
      }
      if (issues.length < 50) break;
    }
    await updateUpstreamSyncState(this.project.id, {
      issueCursor: cursor ?? new Date().toISOString(),
      commentCursor: cursor ?? new Date().toISOString(),
      lastError: null,
    });
    return result;
  }

  private async liveOnce(): Promise<UpstreamSyncPollResult> {
    const result: UpstreamSyncPollResult = { issuesImported: 0, issuesUpdated: 0, commentsImported: 0 };
    const issues = await this.fetchJson<GiteaIssue[]>(
      this.isGithub
      ? `/issues?state=all&per_page=30&sort=updated&direction=desc`
      : `/issues?state=all&type=issues&limit=30&sort=updated&order=desc`
    );
    let issueCursor = this.sync.issue_cursor;
    const prCandidates: { gi: GiteaIssue; existing: IssueRow }[] = [];
    if (issues) {
      for (const gi of issues) {
       try {
        const existing = await getIssueByUpstreamNumber(this.project.id, gi.number);
        // Identity beats the cursor for imports: GitHub's sort=updated listing
        // lags seconds behind creation, so a fresh issue can sit below a cursor
        // another issue's later update already pushed past it — an issue absent
        // locally must always import or that lag loses it forever
        // (ranxianglei/billion-context#1306). The cursor only dedupes state
        // syncs of rows we already mirror.
        if (existing && this.sync.issue_cursor && gi.updated_at <= this.sync.issue_cursor) {
          if (gi.pull_request && gi.state !== "closed") prCandidates.push({ gi, existing });
          continue;
        }
        if (!existing) {
          await this.importIssue(gi, true);
          result.issuesImported++;
          result.commentsImported += await this.importIssueComments(gi, true);
        } else {
          const composedTitle = await this.composeTitle(gi.title, !!gi.pull_request, gi.number);
          // Repair-only recompose: if the mirror already carries a translated
          // lead segment ("EN | 原题"), never rewrite it — translator output is
          // not deterministic, so re-composing every poll would churn every
          // title. Recompose only when the lead is missing (stripped/mangled).
          const missingLead = !existing.title.includes(" | ");
          if (missingLead && existing.title !== composedTitle) {
            await editIssue(existing.id, { title: composedTitle });
          }
          // Label write-back: push agent-applied mirror labels to GitHub (add-only,
          // never removes owner's GitHub-side labels). Creates missing repo-level
          // taxonomy labels first. Owner policy 2026-10-18.
          try {
            const want = (await listLabelsForIssue(existing.id)).map((l) => l.name).filter((n) => n && n !== "pr");
            if (want.length > 0) {
              const gh = (await this.fetchJson<any[]>(`/issues/${gi.number}/labels`)) ?? [];
              const have = new Set((gh as any[]).map((l: any) => String(l?.name)));
              const missing = want.filter((n) => !have.has(n));
              if (missing.length > 0) {
                const repoLabels = (await this.fetchJson<any[]>(`/labels`)) ?? [];
                const repoNames = new Set((repoLabels as any[]).map((l: any) => String(l?.name)));
                for (const n of missing) {
                  if (!repoNames.has(n)) {
                    await fetch(this.api(`/labels`), {
                      method: "POST",
                      headers: { ...this.headers(), "Content-Type": "application/json" },
                      body: JSON.stringify({ name: n, color: "0e8a16" }),
                      signal: AbortSignal.timeout(15_000),
                    });
                    repoNames.add(n);
                  }
                }
                await fetch(this.api(`/issues/${gi.number}/labels`), {
                  method: "POST",
                  headers: { ...this.headers(), "Content-Type": "application/json" },
                  body: JSON.stringify({ labels: missing }),
                  signal: AbortSignal.timeout(15_000),
                });
              }
            }
          } catch {
            // best-effort: label sync must never break the poll cycle
          }
            if (this.titleTranslate && composedTitle !== gi.title) {
              await this.patchUpstreamTitle(gi, composedTitle);
            }
          if (gi.pull_request) {
            await ensureIssueHasLabel(this.project.id, existing.id, "pr", "#576699");
          }
          if (await this.syncIssueState(existing, gi, true)) {
            result.issuesUpdated++;
          }
        }
        if (existing && gi.pull_request && gi.state !== "closed") prCandidates.push({ gi, existing });
        if (gi.updated_at && (!issueCursor || gi.updated_at > issueCursor)) issueCursor = gi.updated_at;
       } catch (err) {
        // One bad item must never wedge the whole stream (2026-10-17 wedge
        // lesson): log, skip its cursor advance, keep the batch moving.
        log.warn(`upstream-sync: item failed for #${gi.number}: ${String(err)} — skipping this cycle`);
       }
      }
    }
    if (this.isGithub && prCandidates.length > 0) {
      await this.clearMergeProbesIfMasterMoved();
    }
    if (this.isGithub) {
      await this.pollMergeGuard();
    }
    if (Date.now() - reprobeDrainThrottle.lastAt >= 60_000) {
      reprobeDrainThrottle.lastAt = Date.now();
      await this.drainMergeReprobe(result);
      await this.drainCiReprobe(result);
    }
    const probeNumbers = mergeProbeCandidates(
      prCandidates.map((c) => c.gi),
      new Map(prCandidates.map((c) => [c.gi.number, c.existing.upstream_merge_checked_at ?? ""])),
      Date.now(),
    );
    for (const c of prCandidates) {
      if (!probeNumbers.includes(c.gi.number)) continue;
      await this.probeMergeState(c.gi, c.existing, result);
      await this.probeCiState(c.gi, c.existing, result);
    }
    await this.probeMasterCi(result);

    let commentCursor = this.sync.comment_cursor;
    const comments = await this.fetchJson<GiteaComment[]>(
      this.isGithub
      ? `/issues/comments?per_page=100${this.sync.comment_cursor ? `&since=${encodeURIComponent(this.sync.comment_cursor)}` : ""}`
      : `/issues/comments?limit=50&sort=updated&order=asc${
          this.sync.comment_cursor ? `&since=${encodeURIComponent(this.sync.comment_cursor)}` : ""
        }`
    );
    if (comments) {
      for (const gc of comments) {
        if (await getCommentByUpstreamId(gc.id)) continue;
        if ((gc.body ?? "").includes("<!-- ework-mirror -->")) continue;
        const upstreamNumber = upstreamIssueNumberFromComment(gc);
        if (!upstreamNumber) continue;
        const local = await getIssueByUpstreamNumber(this.project.id, upstreamNumber);
        if (!local) continue;
        const gcAuthor = gc.user?.login ?? "upstream";
        await ensureUser(gcAuthor, fromGithubBot(gcAuthor) ? "bot" : "human");
        // invisible provenance marker (same as importIssueComments): ework-mirror
        // skips events carrying it, so synced-in comments never echo upstream
        const body = (gc.body ?? "") + "\n\n<!-- upstream-sync -->";
        const row = await postComment(local.id, body, gcAuthor, {
          createdAt: gc.created_at,
          updatedAt: gc.updated_at,
          upstreamCommentId: gc.id,
        });
        void emitCommentEvent(this.project.id, local.id, row.id, this.origin);
        result.commentsImported++;
      }
      const last = comments[comments.length - 1];
      if (last?.updated_at && (!commentCursor || last.updated_at > commentCursor)) commentCursor = last.updated_at;
    }

    await updateUpstreamSyncState(this.project.id, {
      issueCursor: issueCursor ?? undefined,
      commentCursor: commentCursor ?? undefined,
      lastError: null,
    });
    await this.sweepUnannounced();
    return result;
  }

  // Imported-but-unannounced crack (dog/ework-aio#6 2026-10-30): issues #5203/
  // #5204 landed in the mirror with their opened event silently never fanned
  // out, and the cursor then guarantees the poll never looks at them again.
  // This sweep is the backstop — re-emit whatever the emission path lost.
  private async sweepUnannounced(): Promise<void> {
    try {
      const unannounced = await getUnannouncedIssues(this.project.id, 10 * 60_000, 10);
      for (const row of unannounced) {
        log.warn(`upstream-sync: announce sweep re-emitting opened for #${row.upstream_issue_number} (lost announcement)`);
        await emitIssueEvent(this.project.id, row.id, "opened", this.origin);
        await markIssueAnnounced(row.id);
      }
    } catch (err) {
      log.warn(`upstream-sync: announce sweep failed: ${String(err)}`);
    }
  }

  private async importDiscussion(d: GithubDiscussion, emit: boolean): Promise<void> {
    await ensureUser(d.user?.login ?? "upstream", fromGithubBot(d.user?.login) ? "bot" : "human");
    const category = d.category?.name ? `[${d.category.name}] ` : "";
    await createIssue(
      this.project.id,
      clipTitle(`${category}${d.title || `#${d.number}`}`),
      d.body ?? "",
      d.user?.login ?? "upstream",
      {
        createdAt: d.created_at,
        updatedAt: d.updated_at,
        state: d.state === "closed" ? "closed" : "open",
        upstreamIssueNumber: d.number,
        number: d.number,
        kind: "discussion",
      }
    );
    if (emit) {
      const created = await getIssueByUpstreamNumber(this.project.id, d.number, "discussion");
      if (created) void emitIssueEvent(this.project.id, created.id, "opened", this.origin);
    }
  }

  private async importDiscussionComments(d: GithubDiscussion, emit: boolean): Promise<number> {
    const local = await getIssueByUpstreamNumber(this.project.id, d.number, "discussion");
    if (!local) return 0;
    const comments = await this.fetchJson<GiteaComment[]>(`/discussions/${d.number}/comments?per_page=50`);
    if (!comments) return 0;
    let n = 0;
    for (const gc of comments) {
      if (await getCommentByUpstreamId(gc.id)) continue;
      if ((gc.body ?? "").includes("<!-- ework-mirror -->")) continue;
      const gcAuthor = gc.user?.login ?? "upstream";
      await ensureUser(gcAuthor, fromGithubBot(gcAuthor) ? "bot" : "human");
      const body = (gc.body ?? "") + "\n\n<!-- upstream-sync -->";
      const row = await postComment(local.id, body, gcAuthor, {
        createdAt: gc.created_at,
        updatedAt: gc.updated_at,
        upstreamCommentId: gc.id,
      });
      if (emit) void emitCommentEvent(this.project.id, local.id, row.id, this.origin);
      n++;
    }
    return n;
  }

  private async syncDiscussionState(existing: IssueRow, d: GithubDiscussion, emit: boolean): Promise<boolean> {
    const target: "open" | "closed" = d.state === "closed" ? "closed" : "open";
    if (existing.state === target) return false;
    await editIssue(existing.id, { state: target });
    if (target === "closed" && existing.ai_status && existing.ai_status !== "completed") {
      await updateIssueAiStatus(existing.id, "");
    }
    if (emit) {
      void emitIssueEvent(this.project.id, existing.id, target === "closed" ? "closed" : "reopened", this.origin);
    }
    return true;
  }

  // Single-thread listening (owner policy 2026-10-18): when a whitelist is
  // configured only listed discussion numbers sync; everything else in the
  // repo (discussions AND issues, via issuesEnabled=false) stays untouched.
  private discussionAllowed(n: number): boolean {
    return !this.discussionWhitelist || this.discussionWhitelist.includes(String(n));
  }

  private async discussionsBackfill(): Promise<void> {
    const list = await this.fetchJson<GithubDiscussion[]>("/discussions?per_page=50");
    if (!list) {
      await updateUpstreamSyncState(this.project.id, { discussionCursor: new Date().toISOString() });
      return;
    }
    let cursor: string | null = null;
    for (const d of list) {
      if (!this.discussionAllowed(d.number)) continue;
      if (!(await getIssueByUpstreamNumber(this.project.id, d.number, "discussion"))) {
        await this.importDiscussion(d, false);
      }
      await this.importDiscussionComments(d, false);
      if (d.updated_at && (!cursor || d.updated_at > cursor)) cursor = d.updated_at;
    }
    await updateUpstreamSyncState(this.project.id, { discussionCursor: cursor ?? new Date().toISOString() });
  }

  private async discussionsLive(): Promise<void> {
    let cursor = this.sync.discussion_cursor;
    // The REST discussions list has no updated-desc ordering guarantee; a
    // fixed first page silently hides recently-active threads that sit deeper
    // in the list (incident: #5795 at index 45 invisible to per_page=30,
    // 2026-10-19). Walk up to 3 pages of 100 per poll.
    for (let page = 1; page <= 3; page++) {
      const list = await this.fetchJson<GithubDiscussion[]>(`/discussions?per_page=100&page=${page}`);
      if (!list || list.length === 0) break;
      for (const d of list) {
        if (!this.discussionAllowed(d.number)) continue;
        const existing = await getIssueByUpstreamNumber(this.project.id, d.number, "discussion");
        if (existing && this.sync.discussion_cursor && d.updated_at <= this.sync.discussion_cursor) continue;
        if (!existing) {
          await this.importDiscussion(d, true);
          await this.importDiscussionComments(d, true);
        } else {
          if (await this.syncDiscussionState(existing, d, true)) {
            log.info(`upstream-sync: discussion #${d.number} state -> ${d.state} (${this.project.owner}/${this.project.name})`);
          }
          await this.importDiscussionComments(d, true);
        }
        if (d.updated_at && (!cursor || d.updated_at > cursor)) cursor = d.updated_at;
      }
      if (list.length < 100) break;
    }
    if (cursor && cursor !== this.sync.discussion_cursor) {
      await updateUpstreamSyncState(this.project.id, { discussionCursor: cursor });
    }
  }

  async pollOnce(): Promise<UpstreamSyncPollResult> {
    if (this.discussionsEnabled) {
      if (this.sync.discussion_cursor === null) await this.discussionsBackfill();
      else await this.discussionsLive();
    }
    if (!this.issuesEnabled) return { issuesImported: 0, issuesUpdated: 0, commentsImported: 0 };
    return this.isBackfill ? await this.backfillOnce() : await this.liveOnce();
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
// project_id -> tick start time. A stale entry (>10 min) means the previous
// poll never settled (hung fetch/subprocess despite per-call timeouts) — the
// watchdog re-arms the project instead of dropping it from polling forever
// (incident: awesome-dsh-plugin silent stop 2026-10-18).
const inFlight = new Map<number, number>();
const IN_FLIGHT_TTL_MS = 10 * 60_000;

async function tick(cfg: Config): Promise<void> {
  const rows = await listEnabledUpstreamSyncs();
  for (const row of rows) {
    const startedAt = inFlight.get(row.project_id);
    if (startedAt !== undefined && Date.now() - startedAt < IN_FLIGHT_TTL_MS) continue;
    const interval = Math.max(10_000, row.poll_interval_ms);
    if (row.last_poll_at && Date.now() - Date.parse(row.last_poll_at) < interval) continue;
    inFlight.set(row.project_id, Date.now());
    void (async () => {
      try {
        const project = await getProjectById(row.project_id);
        if (!project) return;
        const cfgKv = await getConfigAll();
        const discussionsEnabled = cfgKv[`discussions:${project.owner}/${project.name}`] === "1";
        const titleTranslate = cfgKv[`titleTranslate:${project.owner}/${project.name}`] === "1";
        const issuesEnabled = cfgKv[`issuesSync:${project.owner}/${project.name}`] !== "0";
        const discussionWhitelist = cfgKv[`discussionWhitelist:${project.owner}/${project.name}`] || undefined;
        const sync = new UpstreamSync(row, project, syncOrigin(cfg), discussionsEnabled, issuesEnabled, discussionWhitelist, titleTranslate);
        const r = await sync.pollOnce();
        if (r.issuesImported || r.issuesUpdated || r.commentsImported) {
          log.info("upstream-sync: polled", {
            project: `${project.owner}/${project.name}`,
            imported: r.issuesImported,
            updated: r.issuesUpdated,
            comments: r.commentsImported,
          });
        }
      } catch (e) {
        log.warn(`upstream-sync: poll failed for project ${row.project_id}: ${(e as Error).message}`);
        await updateUpstreamSyncState(row.project_id, { lastError: (e as Error).message }).catch(() => {});
      } finally {
        inFlight.delete(row.project_id);
      }
    })();
  }
}

export function startUpstreamSyncPoller(cfg: Config): void {
  if (tickTimer) return;
  // 2026-10-28: 15s -> 45s (env UPSTREAM_POLL_MS). Measured burn with the old
  // tick: 88 req/min sustained = 5280/h against a 5000/h PAT budget — the
  // mirror baseline alone exhausted the quota every rolling hour, blinding
  // the whole fleet (zero webhook forwards while dark). 45s keeps the same
  // per-tick shape at 1/3 the rate; guard slice widened 10->16 to compensate
  // rotation latency.
  const ms = Math.max(15_000, Number(process.env.UPSTREAM_POLL_MS ?? 45_000));
  tickTimer = setInterval(() => {
    void tick(cfg);
  }, ms);
  log.info(`upstream-sync: poller started (tick=${ms / 1000}s)`);
}

export function stopUpstreamSyncPoller(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}
