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
// endpoint Gitea also has, so we use that single call and parse each hit's
// scope out of its url field.

export interface WebReconcileOptions {
  webUrl: string;
  token: string;
  scopes: string[];
  store: Store;
  fetchImpl?: (input: URL | string, init?: RequestInit) => Promise<Response>;
  limit?: number;
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
  const limit = opts.limit ?? 100;
  const result: WebReconcileResult = { checked: 0, matched: 0, restored: 0 };
  if (scopes.length === 0) return result;

  const res = await fetchImpl(
    `${webUrl}/api/v1/repos/issues/search?q=&state=open&type=issues&limit=${limit}`,
    { headers: { Authorization: `token ${token}` } },
  );
  if (!res.ok) throw new Error(`web reconcile: search responded ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("web reconcile: unexpected response shape");

  const wanted = new Set(scopes);
  for (const raw of body as WebIssueItem[]) {
    result.checked++;
    const scope = parseScope(raw);
    if (!scope || !wanted.has(scope.scopeKey)) continue;
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
  return result;
}
