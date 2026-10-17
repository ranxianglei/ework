import {
  type UpstreamSyncRow,
  type ProjectRow,
  type IssueRow,
  getProjectById,
  getIssue,
  getIssueByUpstreamNumber,
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
  updateUpstreamSyncState,
  listEnabledUpstreamSyncs,
} from "./store";
import { emitIssueEvent, emitCommentEvent, emitMergeConflictEvent, emitCiFailedEvent } from "./webhooks";
import { getConfigAll } from "./db";
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

export const MERGE_PROBE_WINDOW_MS = 172_800_000;
export const MERGE_PROBE_PER_POLL = 5;

// PR conflict state only changes when head or base moves, and any move bumps
// the PR's updated_at — so probing only PRs whose updated_at advanced past the
// last probe covers every transition with zero requests for quiet PRs
// (owner policy 2026-10-14: activity window is the trailing 48h, older PRs are skipped).
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

export class UpstreamSync {
  private readonly sync: UpstreamSyncRow;
  private readonly project: ProjectRow;
  private readonly origin: string;
  private readonly discussionsEnabled: boolean;
  private readonly titleTranslate: boolean;
  private readonly titleCache = new Map<string, string>();

  constructor(
    sync: UpstreamSyncRow,
    project: ProjectRow,
    origin: string,
    discussionsEnabled = false,
    titleTranslate = false,
  ) {
    this.sync = sync;
    this.project = project;
    this.origin = origin;
    const githubUpstream = sync.base_url.toLowerCase().includes("github.com");
    this.discussionsEnabled = discussionsEnabled && githubUpstream;
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
    const resp = await fetch(this.api(path), { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`upstream ${path} -> ${resp.status}`);
    return (await resp.json()) as T;
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

  private async composeTitle(rawTitle: string | undefined, isPr: boolean, number: number): Promise<string> {
    const raw = rawTitle || `#${number}`;
    const prefix = isPr ? "[PR] " : "";
    if (!this.titleTranslate || !CJK_RE.test(raw)) return clipTitle(prefix + raw);
    let en = this.titleCache.get(raw);
    if (en === undefined) {
      en = (await titleTranslator(raw)) ?? "";
      this.titleCache.set(raw, en);
    }
    if (!en) return clipTitle(prefix + raw);
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
    if (emit && created) {
      void emitIssueEvent(this.project.id, created.id, "opened", this.origin);
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
    const was = existing.upstream_mergeable_state;
    await updateIssueMergeState(existing.id, state, gi.updated_at ?? new Date().toISOString());
    if (state === "dirty" && was !== "dirty") {
      log.info(`upstream-sync: merge conflict detected on upstream PR #${gi.number} (${this.project.owner}/${this.project.name})`);
      await emitMergeConflictEvent(this.project.id, existing.id, this.origin, state);
      result.issuesUpdated++;
    }
  }

  // CI-failure wake (owner policy 2026-10-14): probe check-runs for the PR's
  // head sha; on a NEW failing sha (max 2 auto-fix attempts per PR) emit a
  // ci_failed event so the daemon routes a sticky ci-worker at it. Conflicts
  // got their auto lane first; CI failures now have one too.
  private async probeCiState(gi: GiteaIssue, existing: IssueRow, result: UpstreamSyncPollResult): Promise<void> {
    if (!this.isGithub || existing.kind !== "issue" || !gi.title.startsWith("[PR]")) return;
    const pull = await this.fetchJson<PullRequestPayload>(`/pulls/${gi.number}`);
    const sha = pull?.head?.sha ?? null;
    if (!sha) return;
    const checks = await this.fetchJson<CheckRunPayload[]>(`/commits/${sha}/check-runs?filter=latest`);
    if (!checks) return;
    const failed = checks.filter((c) => c.conclusion === "failure");
    if (failed.length === 0) {
      if (existing.upstream_ci_state) await updateIssueCiState(existing.id, null);
      return;
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
      return;
    }
    log.info(`upstream-sync: CI failure detected on upstream PR #${gi.number} (${this.project.owner}/${this.project.name})`);
    await emitCiFailedEvent(
      this.project.id,
      existing.id,
      this.origin,
      sha,
      failed.map((c) => ({ name: c.name ?? "check", html_url: c.html_url ?? "", conclusion: "failure" })),
    );
    await updateIssueCiState(existing.id, decision.next ? JSON.stringify(decision.next satisfies CiProbeState) : null);
    result.issuesUpdated++;
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
          log.warn(`upstream-sync: backfill item failed for #${gi.number}: ${String(err)} — skipping`);
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
            if (this.titleTranslate && composedTitle !== gi.title) {
              await this.patchUpstreamTitle(gi, composedTitle);
            }
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
    return result;
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

  private async discussionsBackfill(): Promise<void> {
    const list = await this.fetchJson<GithubDiscussion[]>("/discussions?per_page=50");
    if (!list) {
      await updateUpstreamSyncState(this.project.id, { discussionCursor: new Date().toISOString() });
      return;
    }
    let cursor: string | null = null;
    for (const d of list) {
      if (!(await getIssueByUpstreamNumber(this.project.id, d.number, "discussion"))) {
        await this.importDiscussion(d, false);
      }
      await this.importDiscussionComments(d, false);
      if (d.updated_at && (!cursor || d.updated_at > cursor)) cursor = d.updated_at;
    }
    await updateUpstreamSyncState(this.project.id, { discussionCursor: cursor ?? new Date().toISOString() });
  }

  private async discussionsLive(): Promise<void> {
    const list = await this.fetchJson<GithubDiscussion[]>("/discussions?per_page=30");
    if (!list) return;
    let cursor = this.sync.discussion_cursor;
    for (const d of list) {
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
    if (cursor && cursor !== this.sync.discussion_cursor) {
      await updateUpstreamSyncState(this.project.id, { discussionCursor: cursor });
    }
  }

  async pollOnce(): Promise<UpstreamSyncPollResult> {
    if (this.discussionsEnabled) {
      if (this.sync.discussion_cursor === null) await this.discussionsBackfill();
      else await this.discussionsLive();
    }
    return this.isBackfill ? await this.backfillOnce() : await this.liveOnce();
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
const inFlight = new Set<number>();

async function tick(cfg: Config): Promise<void> {
  const rows = await listEnabledUpstreamSyncs();
  for (const row of rows) {
    if (inFlight.has(row.project_id)) continue;
    const interval = Math.max(10_000, row.poll_interval_ms);
    if (row.last_poll_at && Date.now() - Date.parse(row.last_poll_at) < interval) continue;
    inFlight.add(row.project_id);
    void (async () => {
      try {
        const project = await getProjectById(row.project_id);
        if (!project) return;
        const cfgKv = await getConfigAll();
        const discussionsEnabled = cfgKv[`discussions:${project.owner}/${project.name}`] === "1";
        const titleTranslate = cfgKv[`titleTranslate:${project.owner}/${project.name}`] === "1";
        const sync = new UpstreamSync(row, project, syncOrigin(cfg), discussionsEnabled, titleTranslate);
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
  tickTimer = setInterval(() => {
    void tick(cfg);
  }, 15_000);
  log.info("upstream-sync: poller started (tick=15s)");
}

export function stopUpstreamSyncPoller(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}
