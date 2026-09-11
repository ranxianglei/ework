import type { PollingTracker, SyncExternalIssue, SyncExternalComment, TrackerRef, PollResult } from "../trackers/types";
import { log } from "../logger";

const PROVENANCE_RE = /<!--\s*sync:(\w+):([^\s:]+)(?::([^\s]+))?\s*-->/;

export function withProvenance(sourceType: string, externalId: string, body: string): string {
  const marker = `<!-- sync:${sourceType}:${externalId} -->`;
  return body.endsWith("\n") ? `${body}${marker}` : `${body}\n${marker}`;
}

export function extractProvenance(body: string): { sourceType: string; externalId: string; commentId?: string } | null {
  const m = body.match(PROVENANCE_RE);
  if (!m) return null;
  return { sourceType: m[1]!, externalId: m[2]!, commentId: m[3] };
}

export function isSyncMirrored(body: string, sourceType: string): boolean {
  const p = extractProvenance(body);
  return p?.sourceType === sourceType;
}

export interface SyncEngineOptions {
  tracker: PollingTracker;
  scope: Record<string, string>;
  webUrl: string;
  webToken: string;
  owner: string;
  repo: string;
  pollIntervalMs: number;
  cursorFile: string;
  botLogin: string;
}

interface CursorState {
  issueCursor: string | null;
  commentCursors: Record<string, string | null>;
  issueMap: Record<string, number>;
}

async function loadCursors(path: string): Promise<CursorState> {
  try {
    const f = Bun.file(path);
    if (await f.exists()) return await f.json();
  } catch { /* first run */ }
  return { issueCursor: null, commentCursors: {}, issueMap: {} };
}

async function saveCursors(path: string, state: CursorState): Promise<void> {
  try {
    await Bun.write(path, JSON.stringify(state, null, 2));
  } catch (e) {
    log.warn(`sync: failed to save cursors: ${(e as Error).message}`);
  }
}

export class SyncEngine {
  private opts: SyncEngineOptions;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: SyncEngineOptions) {
    this.opts = opts;
  }

  async pollOnce(): Promise<void> {
    const state = await loadCursors(this.opts.cursorFile);
    const { tracker, scope, webUrl, webToken, owner, repo } = this.opts;

    const issueResult: PollResult<SyncExternalIssue> = await tracker.listChangedIssues(scope, state.issueCursor);
    for (const ext of issueResult.items) {
      const existingLocal = state.issueMap[ext.externalId];
      if (ext.state === "open" && !existingLocal) {
        const body = withProvenance(tracker.type, ext.externalId, ext.body);
        const resp = await fetch(`${webUrl}/api/v1/repos/${owner}/${repo}/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `token ${webToken}` },
          body: JSON.stringify({ title: ext.title, body, assignee: ext.author }),
        });
        if (resp.ok) {
          const data = await resp.json() as { number: number };
          state.issueMap[ext.externalId] = data.number;
          log.info(`sync: created issue #${data.number} from ${tracker.type}:${ext.externalId}`);
        } else {
          log.warn(`sync: create issue failed: ${resp.status} ${await resp.text()}`);
        }
      }
    }
    state.issueCursor = issueResult.nextCursor ?? state.issueCursor;

    for (const [extId, issueNum] of Object.entries(state.issueMap)) {
      const ref: TrackerRef = { trackerType: tracker.type, scope, issueId: String(issueNum) };
      const cCursor = state.commentCursors[extId] ?? null;
      const cResult: PollResult<SyncExternalComment> = await tracker.listChangedComments(ref, cCursor);
      for (const c of cResult.items) {
        if (tracker.isBotUser(c.author)) continue;
        const body = withProvenance(tracker.type, extId, c.body);
        const resp = await fetch(`${webUrl}/api/v1/repos/${owner}/${repo}/issues/${issueNum}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `token ${webToken}` },
          body: JSON.stringify({ body }),
        });
        if (resp.ok) {
          log.info(`sync: created comment on issue #${issueNum} from ${tracker.type}:${extId}:${c.externalId}`);
        } else {
          log.warn(`sync: create comment failed: ${resp.status}`);
        }
      }
      state.commentCursors[extId] = cResult.nextCursor ?? cCursor;
    }

    await saveCursors(this.opts.cursorFile, state);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info(`sync: poll loop started (interval=${this.opts.pollIntervalMs}ms, source=${this.opts.tracker.type})`);
    this.pollOnce().catch(e => log.error(`sync: poll error: ${(e as Error).message}`));
    this.timer = setInterval(() => {
      this.pollOnce().catch(e => log.error(`sync: poll error: ${(e as Error).message}`));
    }, this.opts.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    log.info("sync: poll loop stopped");
  }
}
