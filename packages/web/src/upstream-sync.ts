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
  updateUpstreamSyncState,
  listEnabledUpstreamSyncs,
} from "./store";
import { emitIssueEvent, emitCommentEvent } from "./webhooks";
import { log } from "./logger";
import type { Config } from "./config";

interface GiteaIssue {
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

export function syncOrigin(cfg: Config): string {
  const first = cfg.publicOrigins[0];
  if (first) return first.replace(/\/+$/, "");
  return `http://127.0.0.1:${cfg.port}`;
}

export class UpstreamSync {
  private readonly sync: UpstreamSyncRow;
  private readonly project: ProjectRow;
  private readonly origin: string;

  constructor(sync: UpstreamSyncRow, project: ProjectRow, origin: string) {
    this.sync = sync;
    this.project = project;
    this.origin = origin;
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
    await createIssue(
      this.project.id,
      (gi.pull_request ? "[PR] " : "") + (gi.title || `#${gi.number}`),
      gi.body ?? "",
      gi.user?.login ?? "upstream",
      {
        createdAt: gi.created_at,
        updatedAt: gi.updated_at,
        state: gi.state === "closed" ? "closed" : "open",
        upstreamIssueNumber: gi.number,
      }
    );
    // PRs the sandbox agent opens itself carry the ework-agent-pr marker;
    // announcing them would wake the agent on its own artifact (feedback loop)
    const agentAuthored = !!gi.pull_request && /<!--\s*ework-agent-pr\s*-->/.test(gi.body ?? "");
    if (emit && !agentAuthored) {
      const created = await getIssueByUpstreamNumber(this.project.id, gi.number);
      if (created) void emitIssueEvent(this.project.id, created.id, "opened", this.origin);
    }
  }

  private async syncIssueState(existing: IssueRow, gi: GiteaIssue, emit: boolean): Promise<boolean> {
    const target: "open" | "closed" = gi.state === "closed" ? "closed" : "open";
    if (existing.state === target) return false;
    await editIssue(existing.id, { state: target });
    if (emit) {
      void emitIssueEvent(this.project.id, existing.id, target === "closed" ? "closed" : "reopened", this.origin);
    }
    return true;
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
          ? `/issues?state=open&per_page=50&page=${page}&sort=created&direction=asc`
          : `/issues?state=open&type=issues&limit=50&page=${page}&sort=created&order=asc`
      );
      if (!issues || issues.length === 0) break;
      for (const gi of issues) {
        if (!(await getIssueByUpstreamNumber(this.project.id, gi.number))) {
          await this.importIssue(gi, false);
          result.issuesImported++;
        }
        result.commentsImported += await this.importIssueComments(gi, false);
        if (gi.updated_at && (!cursor || gi.updated_at > cursor)) cursor = gi.updated_at;
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
    if (issues) {
      for (const gi of issues) {
        if (this.sync.issue_cursor && gi.updated_at <= this.sync.issue_cursor) continue;
        const existing = await getIssueByUpstreamNumber(this.project.id, gi.number);
        if (!existing) {
          await this.importIssue(gi, true);
          result.issuesImported++;
          result.commentsImported += await this.importIssueComments(gi, true);
        } else if (await this.syncIssueState(existing, gi, true)) {
          result.issuesUpdated++;
        }
        if (gi.updated_at && (!issueCursor || gi.updated_at > issueCursor)) issueCursor = gi.updated_at;
      }
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
        const row = await postComment(local.id, gc.body ?? "", gcAuthor, {
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

  async pollOnce(): Promise<UpstreamSyncPollResult> {
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
        const sync = new UpstreamSync(row, project, syncOrigin(cfg));
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
