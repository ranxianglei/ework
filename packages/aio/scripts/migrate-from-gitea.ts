#!/usr/bin/env bun
// ework-aio migrate: Gitea → ework-web migration via the shared Gitea REST
// protocol (source = Gitea; target = ework-web's Gitea-compat shim).
//
// Invariants that aren't obvious from the code alone:
//   1. Target POSTs MUST authenticate as the `awork` bot user. ework-mirror
//      treats `awork` as a self-emitter and skips echo-back to source Gitea.
//      Any other login → duplicates in source. We verify the token resolves
//      to `awork` on startup and refuse to run otherwise.
//   2. Idempotent. A SQLite ledger keyed on (source_url, source_id) records
//      every migrated item. Re-runs only catch up. The user anticipates two
//      passes: bulk first while :1195 still active, catch-up after cutover.
//   3. Out of scope (v1): attachments, edits, deletes, labels, milestones,
//      assignments, reactions.

import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";


const { values } = parseArgs({
  options: {
    "source-url": { type: "string" },
    "source-token": { type: "string" },
    "target-url": { type: "string" },
    "target-token": { type: "string" },
    repo: { type: "string", multiple: true, default: [] },
    "mark-complete": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    ledger: { type: "string" },
    "data-dir": { type: "string" },
    "sleep-ms": { type: "string" }, // politeness delay between POSTs
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  tokens: true,
});

if (values.help) {
  process.stdout.write(`Usage: ework-aio migrate --source-url URL --source-token TOKEN [options]

Required:
  --source-url URL        Source Gitea base URL (e.g. http://192.168.10.96:3300)
  --source-token TOKEN    Source Gitea access token (read access to all repos
                          you want to migrate)

Target (auto-filled from ~/.local/share/ework-aio/ework-web/.env if missing):
  --target-url URL        ework-web URL (default http://[::1]:<WORK_PORT>)
  --target-token TOKEN    ework-web PAT for the \`awork\` bot user. MUST be the
                          \`awork\` login so ework-mirror sees a self-emitter
                          and skips echo-back to source Gitea.

Selection:
  --repo owner/name       Only migrate these repos (repeatable). Default: all
                          repos visible to --source-token.

Misc:
  --mark-complete         Write .migration-complete flag after a successful
                          run. Signals that :1196 is ready to serve users.
  --dry-run               Don't POST anything; just print what would happen
                          and what's already in the ledger.
  --ledger PATH           Override ledger DB path.
  --data-dir PATH         Override ework-aio data dir.
  --sleep-ms N            Politeness delay between target POSTs (default 50).
  -h, --help              Show this help.
`);
  process.exit(0);
}


const DATA_DIR = values["data-dir"] ?? join(homedir(), ".local/share/ework-aio");
const LEDGER_PATH = values["ledger"] ?? join(DATA_DIR, "migration-ledger.db");
const COMPLETE_FLAG = join(DATA_DIR, ".migration-complete");
const SLEEP_MS = Number(values["sleep-ms"] ?? 50);

const sourceUrl = (values["source-url"] ?? "").replace(/\/+$/, "");
const sourceToken = values["source-token"] ?? "";

let targetUrl = (values["target-url"] ?? "").replace(/\/+$/, "");
let targetToken = values["target-token"] ?? "";

if (!sourceUrl || !sourceToken) {
  console.error("error: --source-url and --source-token are required");
  process.exit(2);
}

// Auto-fill target from ework-web .env. We read the file directly rather
// than spawning a shell because this script may run in contexts where
// systemd isn't fully initialised yet.
if (!targetUrl || !targetToken) {
  const envPath = join(DATA_DIR, "ework-web/.env");
  if (existsSync(envPath)) {
    const kv: Record<string, string> = {};
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (!targetUrl && kv.WORK_PORT) {
      targetUrl = `http://[::1]:${kv.WORK_PORT}`;
    }
    if (!targetToken && kv.WORK_TOKEN) {
      // WORK_TOKEN is the admin bootstrap token (resolves to operator login,
      // usually `dog`). This works but bypasses loop-suppression — only use
      // it for --dry-run or if ework-mirror isn't installed yet.
      targetToken = kv.WORK_TOKEN;
    }
  }
}

if (!targetUrl || !targetToken) {
  console.error(
    "error: --target-url and --target-token required (and couldn't auto-fill from ework-web/.env)"
  );
  process.exit(2);
}


mkdirSync(DATA_DIR, { recursive: true });
const ledger = new Database(LEDGER_PATH);
ledger.exec("PRAGMA journal_mode = WAL");
ledger.exec("PRAGMA synchronous = NORMAL");
ledger.exec(`
  CREATE TABLE IF NOT EXISTS issue_map (
    source_url TEXT NOT NULL,
    source_repo TEXT NOT NULL,
    source_issue_number INTEGER NOT NULL,
    target_repo TEXT NOT NULL,
    target_issue_number INTEGER NOT NULL,
    migrated_at TEXT NOT NULL,
    PRIMARY KEY (source_url, source_repo, source_issue_number)
  );
  CREATE TABLE IF NOT EXISTS comment_map (
    source_url TEXT NOT NULL,
    source_comment_id INTEGER NOT NULL,
    source_repo TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    target_issue_number INTEGER NOT NULL,
    target_comment_id INTEGER NOT NULL,
    migrated_at TEXT NOT NULL,
    PRIMARY KEY (source_url, source_comment_id)
  );
  CREATE TABLE IF NOT EXISTS repo_map (
    source_url TEXT NOT NULL,
    source_repo TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    migrated_at TEXT NOT NULL,
    PRIMARY KEY (source_url, source_repo)
  );
`);

const stmt = {
  insIssue: ledger.prepare(
    `INSERT OR IGNORE INTO issue_map VALUES (?, ?, ?, ?, ?, ?)`
  ),
  seenIssue: ledger.prepare(
    `SELECT target_issue_number FROM issue_map WHERE source_url=? AND source_repo=? AND source_issue_number=?`
  ),
  insComment: ledger.prepare(
    `INSERT OR IGNORE INTO comment_map VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  seenComment: ledger.prepare(
    `SELECT 1 FROM comment_map WHERE source_url=? AND source_comment_id=?`
  ),
  insRepo: ledger.prepare(
    `INSERT OR IGNORE INTO repo_map VALUES (?, ?, ?, ?)`
  ),
  seenRepo: ledger.prepare(
    `SELECT 1 FROM repo_map WHERE source_url=? AND source_repo=?`
  ),
  countIssues: ledger.prepare(`SELECT COUNT(*) AS n FROM issue_map`),
  countComments: ledger.prepare(`SELECT COUNT(*) AS n FROM comment_map`),
  countRepos: ledger.prepare(`SELECT COUNT(*) AS n FROM repo_map`),
};


class ApiError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Don't retry on 4xx (caller will handle or surface); only 5xx / network.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
      if (attempt < 3) {
        const backoff = 500 * 2 ** attempt;
        console.error(`  ${label}: transient error (${errSummary(e)}); retry in ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

function errSummary(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function srcGet<T = any>(path: string): Promise<T | null> {
  return withRetry(`GET ${sourceUrl}${path}`, async () => {
    const r = await fetch(`${sourceUrl}${path}`, {
      headers: { Authorization: `token ${sourceToken}` },
    });
    if (r.status === 404) return null;
    if (r.status === 409) return null; // empty/archived repos sometimes 409
    if (!r.ok) {
      throw new ApiError(r.status, `source ${path}: HTTP ${r.status}`, await r.text());
    }
    return (await r.json()) as T;
  });
}

async function tgtGet(path: string): Promise<any | null> {
  return withRetry(`GET ${targetUrl}${path}`, async () => {
    const r = await fetch(`${targetUrl}${path}`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      throw new ApiError(r.status, `target ${path}: HTTP ${r.status}`, await r.text());
    }
    return await r.json();
  });
}

async function tgtPostJson(path: string, body: unknown): Promise<any> {
  if (values["dry-run"]) {
    console.error(`  [dry-run] POST ${targetUrl}${path} ${JSON.stringify(body).slice(0, 100)}…`);
    return { number: -1, id: -1 };
  }
  return withRetry(`POST ${targetUrl}${path}`, async () => {
    const r = await fetch(`${targetUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${targetToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new ApiError(r.status, `target POST ${path}: HTTP ${r.status}`, await r.text());
    }
    return await r.json();
  });
}

async function tgtPatchJson(path: string, body: unknown): Promise<void> {
  if (values["dry-run"]) {
    console.error(`  [dry-run] PATCH ${targetUrl}${path} ${JSON.stringify(body)}`);
    return;
  }
  await withRetry(`PATCH ${targetUrl}${path}`, async () => {
    const r = await fetch(`${targetUrl}${path}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${targetToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new ApiError(r.status, `target PATCH ${path}: HTTP ${r.status}`, await r.text());
    }
  });
}

async function tgtPostForm(path: string, form: Record<string, string>): Promise<void> {
  // ework-web's /projects flow is form-encoded + 303-redirect on success.
  if (values["dry-run"]) {
    console.error(`  [dry-run] POST ${targetUrl}${path} (form) ${JSON.stringify(form)}`);
    return;
  }
  await withRetry(`POST ${targetUrl}${path}`, async () => {
    const r = await fetch(`${targetUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${targetToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      redirect: "manual", // don't chase the 303 — it just leads back to UI
    });
    // 303 / 302 = success (handler redirects to issue list). Other 3xx also OK.
    if (r.status >= 300 && r.status < 400) return;
    if (!r.ok) {
      throw new ApiError(r.status, `target POST ${path}: HTTP ${r.status}`, await r.text());
    }
  });
}


interface SourceRepo {
  full_name: string;
  owner: string;
  name: string;
}

async function listSourceRepos(): Promise<SourceRepo[]> {
  const out: SourceRepo[] = [];
  let page = 1;
  while (true) {
    const data = await srcGet<{ data: Array<{ full_name: string; owner: { login: string }; name: string }> }>(
      `/api/v1/repos/search?limit=50&page=${page}`
    );
    if (!data || !Array.isArray(data.data) || data.data.length === 0) break;
    for (const r of data.data) {
      out.push({ full_name: r.full_name, owner: r.owner.login, name: r.name });
    }
    if (data.data.length < 50) break;
    page++;
  }
  return out;
}

interface SourceIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  user: { login: string };
}

async function listSourceIssues(owner: string, name: string): Promise<SourceIssue[]> {
  const out: SourceIssue[] = [];
  let page = 1;
  while (true) {
    // Source Gitea (Forgejo) doesn't honor sort/direction params — we sort
    // client-side below. Issue-number parity with source only holds on an
    // empty target, which is the common first-run case.
    const data = await srcGet<SourceIssue[]>(
      `/api/v1/repos/${owner}/${name}/issues?state=all&limit=50&page=${page}`
    );
    if (!data || !Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 50) break;
    page++;
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

interface SourceComment {
  id: number;
  body: string | null;
  created_at: string;
  user: { login: string };
}

async function listSourceComments(
  owner: string,
  name: string,
  issueNumber: number
): Promise<SourceComment[]> {
  // Forgejo's /comments endpoint ignores `page` — every page returns the
  // full set. Detect that via a seen-IDs set: once we re-see an ID, stop.
  const out: SourceComment[] = [];
  const seen = new Set<number>();
  let page = 1;
  while (true) {
    const data = await srcGet<SourceComment[]>(
      `/api/v1/repos/${owner}/${name}/issues/${issueNumber}/comments?limit=50&page=${page}`
    );
    if (!data || !Array.isArray(data) || data.length === 0) break;
    let dupes = 0;
    for (const c of data) {
      if (seen.has(c.id)) {
        dupes++;
        continue;
      }
      seen.add(c.id);
      out.push(c);
    }
    // If every item on this page was already seen, Forgejo is repeating → stop.
    if (dupes === data.length) break;
    if (data.length < 50) break;
    page++;
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}


async function main() {
  const started = Date.now();

  // Verify target token resolves to `awork` (loop-suppression requirement).
  const me = await tgtGet(`/api/v1/user`);
  if (!me || typeof me.login !== "string") {
    console.error("error: couldn't read /api/v1/user on target — token invalid?");
    process.exit(2);
  }
  const wantsLogin = "awork";
  if (me.login !== wantsLogin) {
    console.error(`error: target token resolves to user "${me.login}", expected "${wantsLogin}".`);
    console.error(`       Loop suppression requires the awork bot PAT.`);
    console.error(`       Mint one in ework-web: login as admin → Admin → Users → create`);
    console.error(`       \`awork\` (kind=bot), then as awork → /me/tokens → create PAT.`);
    if (!values["dry-run"]) process.exit(2);
    else console.error(`       (continuing because --dry-run)`);
  } else {
    console.error(`ok: target auth resolves to "${me.login}" (loop-suppression-safe)`);
  }

  const repoFilter = values.repo;
  const allRepos = await listSourceRepos();
  const wantRepos = repoFilter.length
    ? allRepos.filter((r) => repoFilter.includes(r.full_name))
    : allRepos;

  if (wantRepos.length === 0) {
    console.error(`no repos to process (filter: ${repoFilter.join(",") || "<all>"})`);
    console.error(`source listed ${allRepos.length} repos total`);
    process.exit(0);
  }

  console.error(
    `migrating ${wantRepos.length} repo(s) from ${sourceUrl} → ${targetUrl}` +
      (values["dry-run"] ? " (DRY RUN)" : "")
  );

  let newIssues = 0;
  let newComments = 0;
  let skippedIssues = 0;
  let skippedComments = 0;
  let failedIssues = 0;
  let failedComments = 0;

  for (const repo of wantRepos) {
    const fullName = `${repo.owner}/${repo.name}`;
    console.error(`\n[${fullName}]`);

    if (!stmt.seenRepo.get(sourceUrl, fullName)) {
      const existing = await tgtGet(`/api/v1/repos/${repo.owner}/${repo.name}`);
      if (!existing) {
        console.error(`  target project missing; creating as ${me.login}…`);
        try {
          await tgtPostForm(`/projects`, {
            owner: repo.owner,
            name: repo.name,
            description: `(migrated from ${sourceUrl}/${fullName})`,
          });
        } catch (e) {
          // Most likely race with parallel migration or pre-existing. Recheck.
          const recheck = await tgtGet(`/api/v1/repos/${repo.owner}/${repo.name}`);
          if (!recheck) {
            console.error(`  failed to create target project: ${errSummary(e)}`);
            continue;
          }
        }
      }
      if (!values["dry-run"]) {
        stmt.insRepo.run(sourceUrl, fullName, fullName, new Date().toISOString());
      }
    } else {
      console.error(`  repo already in ledger (skip ensure)`);
    }

    const issues = await listSourceIssues(repo.owner, repo.name);
    console.error(`  ${issues.length} source issue(s)`);

    let i = 0;
    for (const iss of issues) {
      i++;
      const mapped = stmt.seenIssue.get(sourceUrl, fullName, iss.number) as
        | { target_issue_number: number }
        | undefined;

      let targetNum: number;
      let issueIsNew = false;
      if (mapped) {
        targetNum = mapped.target_issue_number;
        skippedIssues++;
      } else {
        issueIsNew = true;
        console.error(`  [${i}/${issues.length}] issue #${iss.number} new → POST…`);
        const prefixedBody = prefixBody(iss.body, iss.user.login, iss.created_at, sourceUrl, fullName);
        try {
          const created = await tgtPostJson(
            `/api/v1/repos/${repo.owner}/${repo.name}/issues`,
            { title: iss.title, body: prefixedBody }
          );
          targetNum = created.number;
          if (!values["dry-run"]) {
            stmt.insIssue.run(
              sourceUrl,
              fullName,
              iss.number,
              fullName,
              targetNum,
              new Date().toISOString()
            );
          }
          newIssues++;
          await sleep(SLEEP_MS);

          // Source closed → PATCH target closed. We do this so the webhook
          // emitter fires a `closed` event that ework-mirror (if installed)
          // replays to source Gitea. Otherwise the source's closed state
          // would be lost in mirror-replicated direction.
          if (iss.state === "closed" && !values["dry-run"]) {
            await tgtPatchJson(
              `/api/v1/repos/${repo.owner}/${repo.name}/issues/${targetNum}`,
              { state: "closed" }
            );
            await sleep(SLEEP_MS);
          }
        } catch (e) {
          failedIssues++;
          console.error(
            `  ! issue #${iss.number} "${iss.title.slice(0, 60)}": ${errSummary(e)}`
          );
          continue;
        }
      }

      // Comment enumeration. For catch-up runs we still need to enumerate to
      // find new comments added since the last run; the per-comment ledger
      // check makes this idempotent.
      const comments = await listSourceComments(repo.owner, repo.name, iss.number);
      if (comments.length === 0) continue;
      if (issueIsNew) {
        console.error(`    ${comments.length} source comment(s)`);
      }
      for (const c of comments) {
        const seen = stmt.seenComment.get(sourceUrl, c.id);
        if (seen) {
          skippedComments++;
          continue;
        }
        try {
          const prefixed = prefixComment(c.body, c.user.login, c.created_at);
          const created = await tgtPostJson(
            `/api/v1/repos/${repo.owner}/${repo.name}/issues/${targetNum}/comments`,
            { body: prefixed }
          );
          if (!values["dry-run"]) {
            stmt.insComment.run(
              sourceUrl,
              c.id,
              fullName,
              fullName,
              targetNum,
              created.id,
              new Date().toISOString()
            );
          }
          newComments++;
          await sleep(SLEEP_MS);
        } catch (e) {
          failedComments++;
          console.error(`    ! comment ${c.id}: ${errSummary(e)}`);
        }
      }
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`\n--- done in ${elapsed}s ---`);
  console.error(`issues:   ${newIssues} new, ${skippedIssues} skipped, ${failedIssues} failed`);
  console.error(`comments: ${newComments} new, ${skippedComments} skipped, ${failedComments} failed`);
  console.error(
    `ledger total: ${(stmt.countRepos.get() as { n: number }).n} repos, ` +
      `${(stmt.countIssues.get() as { n: number }).n} issues, ` +
      `${(stmt.countComments.get() as { n: number }).n} comments`
  );

  if (failedIssues > 0 || failedComments > 0) {
    console.error("\nnote: some items failed — re-run to retry (idempotent ledger)");
    process.exitCode = 1;
  }

  if (values["mark-complete"]) {
    if (!values["dry-run"]) {
      writeFileSync(COMPLETE_FLAG, `${new Date().toISOString()}\n`);
      console.error(`\nwrote ${COMPLETE_FLAG}`);
    } else {
      console.error(`\n[dry-run] would write ${COMPLETE_FLAG}`);
    }
  } else {
    console.error(`\n(note: --mark-complete not given; :1196 status will show "not migrated")`);
  }

  ledger.close();
}

function prefixBody(
  body: string | null,
  author: string,
  createdAt: string,
  sourceUrl: string,
  fullName: string
): string {
  const prefix = `> _Migrated from ${sourceUrl}/${fullName} — original author @${author} at ${createdAt}_\n\n`;
  return prefix + (body ?? "");
}

function prefixComment(body: string | null, author: string, createdAt: string): string {
  const prefix = `> _Originally posted by @${author} at ${createdAt}_\n\n`;
  return prefix + (body ?? "");
}

main().catch((e) => {
  console.error(`fatal: ${errSummary(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
