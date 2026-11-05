import { log } from "../logger";
import type { Store } from "../op";

// Web→daemon open-issue reconciliation (ranxianglei/ework#7, item 4).
//
// The 2026-09-17 incident wiped every issues row out of the engine DB;
// without a row, no webhook can ever schedule a thread again. This module
// periodically pulls the web's list of open issues and re-creates any row
// the daemon lost. It only backfills rows — it never spawns work on its
// own; a restored thread wakes through the normal comment/webhook path.
//
// Endpoint note: the ework-web shim does not implement per-repo
// GET /repos/{owner}/{repo}/issues, but it does serve the cross-repo search
// endpoint Gitea also has, so we page through that endpoint (limit/page) and
// parse each hit's scope out of its url field. A shim that does not know
// `page` repeats the first page; the identical-consecutive-page check below
// stops instead of looping forever.

export interface WebReconcileOptions {
  webUrl: string;
  token: string;
  scopes: string[];
  store: Store;
  fetchImpl?: (input: URL | string, init?: RequestInit) => Promise<Response>;
  /** Page size. The shim caps at 200; larger values are clamped server-side. */
  limit?: number;
  /** Hard cap on pages fetched per run (default 25 → up to 5000 open issues). */
  maxPages?: number;
}

export interface WebReconcileResult {
  checked: number;
  matched: number;
  restored: number;
}

const API_SCOPE_RE = /\/api\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)/;
const HTML_SCOPE_RE = /\/([^/]+)\/([^/]+)\/issues\/(\d+)/;

interface WebIssueItem {
  url?: string;
  html_url?: string;
  number?: number;
  title?: string;
}

function parseScope(item: WebIssueItem): { scopeKey: string; owner: string; repo: string; issueId: string } | undefined {
  const source = item.url ?? item.html_url ?? "";
  const m = source.match(API_SCOPE_RE) ?? source.match(HTML_SCOPE_RE);
  if (!m) return undefined;
  const owner = m[1];
  const repo = m[2];
  const issueId = m[3];
  if (!owner || !repo || !issueId) return undefined;
  return { scopeKey: `${owner}/${repo}`, owner, repo, issueId };
}

export async function reconcileWebIssues(opts: WebReconcileOptions): Promise<WebReconcileResult> {
  const { webUrl, token, scopes, store } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 200;
  const maxPages = Math.min(opts.maxPages ?? 25, 1000);
  const result: WebReconcileResult = { checked: 0, matched: 0, restored: 0 };
  if (scopes.length === 0) return result;

  const wanted = new Set(scopes);
  // Pages are ordered by updated_at DESC without a cursor, so rows can shift
  // between pages while we walk them; the seen-set keeps restore idempotent.
  const seen = new Set<string>();
  let prevPageIds: string[] | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchImpl(
      `${webUrl}/api/v1/repos/issues/search?q=&state=open&type=issues&limit=${limit}&page=${page}`,
      { headers: { Authorization: `token ${token}` } },
    );
    if (!res.ok) throw new Error(`web reconcile: search responded ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("web reconcile: unexpected response shape");
    const items = body as WebIssueItem[];

    // A shim that ignores `page` returns the same first page forever; stop on
    // an identical consecutive page instead of spinning or double-counting.
    const ids = items.map((it) => it.url ?? it.html_url ?? String(it.number ?? ""));
    if (prevPageIds !== null && sameIds(ids, prevPageIds)) break;
    prevPageIds = ids;

    for (const raw of items) {
      result.checked++;
      const scope = parseScope(raw);
      if (!scope || !wanted.has(scope.scopeKey)) continue;
      const key = `${scope.scopeKey}#${scope.issueId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.matched++;
      const existing = await store.findIssue("gitea", scope.scopeKey, scope.issueId);
      if (existing) continue;
      const ref = { trackerType: "gitea", scope: { owner: scope.owner, repo: scope.repo }, issueId: scope.issueId };
      const created = await store.findOrCreateIssue(ref, scope.scopeKey, raw.title ?? "");
      // Open on the web → active here, so the observer picks the thread up.
      await store.updateIssueState(created.id, "active");
      result.restored++;
      log.info(`web-reconcile: restored missing open issue row ${scope.scopeKey}#${scope.issueId}`);
    }

    if (items.length < limit) break; // short page → end of data
  }
  return result;
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
