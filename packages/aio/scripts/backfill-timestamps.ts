#!/usr/bin/env bun
// Backfill created_at / updated_at / closed_at on already-migrated issues
// and comments. The ework-web REST API doesn't accept created_at in POST
// bodies, so the migrate tool wrote everything with server-now timestamps.
// We have local filesystem access to ework.db, so we can UPDATE directly.
//
// Idempotent: re-running just re-applies the same timestamps.

import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    "source-url": { type: "string" },
    "source-token": { type: "string" },
    "data-dir": { type: "string" },
    "ework-db": { type: "string" },
    ledger: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`Usage: ework-aio backfill-timestamps --source-url URL --source-token TOKEN [options]

Reads ~/.local/share/ework-aio/migration-ledger.db, fetches original
created_at / updated_at / closed_at from source Gitea for every migrated
issue + comment, and UPDATEs ework.db in place. Fixes the wrong "all
timestamps are migration time" problem.

Required:
  --source-url URL        Source Gitea base URL
  --source-token TOKEN    Source Gitea read token

Optional:
  --data-dir PATH         ework-aio data dir (default ~/.local/share/ework-aio)
  --ework-db PATH         Override path to ework.db
  --ledger PATH           Override path to migration-ledger.db
`);
  process.exit(0);
}

const DATA_DIR = values["data-dir"] ?? join(homedir(), ".local/share/ework-aio");
const LEDGER_PATH = values.ledger ?? join(DATA_DIR, "migration-ledger.db");
const EWORK_DB_PATH = values["ework-db"] ?? join(DATA_DIR, "ework-web/ework.db");
const sourceUrl = (values["source-url"] ?? "").replace(/\/+$/, "");
const sourceToken = values["source-token"] ?? "";

if (!sourceUrl || !sourceToken) {
  console.error("error: --source-url and --source-token required");
  process.exit(2);
}
if (!existsSync(LEDGER_PATH)) {
  console.error(`error: ledger not found at ${LEDGER_PATH}`);
  process.exit(2);
}
if (!existsSync(EWORK_DB_PATH)) {
  console.error(`error: ework.db not found at ${EWORK_DB_PATH}`);
  process.exit(2);
}

const ledger = new Database(LEDGER_PATH, { readonly: true });
const ework = new Database(EWORK_DB_PATH);
ework.exec("PRAGMA journal_mode = WAL");

const issueMapRows = ledger
  .query(
    `SELECT source_repo, source_issue_number, target_repo, target_issue_number
     FROM issue_map ORDER BY source_repo, source_issue_number`
  )
  .all() as Array<{
  source_repo: string;
  source_issue_number: number;
  target_repo: string;
  target_issue_number: number;
}>;

const commentMapRows = ledger
  .query(
    `SELECT source_repo, source_comment_id, target_repo, target_comment_id
     FROM comment_map ORDER BY source_repo, source_comment_id`
  )
  .all() as Array<{
  source_repo: string;
  source_comment_id: number;
  target_repo: string;
  target_comment_id: number;
}>;

console.error(
  `backfilling ${issueMapRows.length} issues + ${commentMapRows.length} comments`
);

async function srcGet<T = any>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${sourceUrl}${path}`, {
        headers: { Authorization: `token ${sourceToken}` },
      });
      if (r.status === 404) return null;
      if (r.status === 409) return null;
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return (await r.json()) as T;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
  return null;
}

interface SourceIssue {
  number: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  state: "open" | "closed";
}

interface SourceComment {
  id: number;
  created_at: string;
  updated_at: string;
}

const updIssue = ework.prepare(
  `UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?`
);
const getTargetIssueId = ework.prepare(
  `SELECT i.id FROM issues i
   JOIN projects p ON i.project_id = p.id
   WHERE p.owner || '/' || p.name = ? AND i.number = ?`
);
const updComment = ework.prepare(
  `UPDATE comments SET created_at = ?, updated_at = ? WHERE id = ?`
);

let issuesDone = 0;
let issuesSkipped = 0;
let issuesFailed = 0;
const started = Date.now();

for (const row of issueMapRows) {
  const [owner, name] = row.source_repo.split("/");
  if (!owner || !name) {
    issuesFailed++;
    continue;
  }
  try {
    const src = await srcGet<SourceIssue>(
      `/api/v1/repos/${owner}/${name}/issues/${row.source_issue_number}`
    );
    if (!src) {
      issuesSkipped++;
      continue;
    }
    const target = getTargetIssueId.get(row.target_repo, row.target_issue_number) as
      | { id: number }
      | undefined;
    if (!target) {
      issuesSkipped++;
      continue;
    }
    // ework-web's issues table has no closed_at column — closed time is lost.
    updIssue.run(src.created_at, src.updated_at, target.id);
    issuesDone++;
    if (issuesDone % 50 === 0) {
      console.error(`  issues: ${issuesDone}/${issueMapRows.length}`);
    }
  } catch (e) {
    issuesFailed++;
    console.error(`  ! issue ${row.source_repo}#${row.source_issue_number}: ${e instanceof Error ? e.message : e}`);
  }
}

// Comments — Forgejo doesn't expose a "comments by ID" batch endpoint, so we
// hit per-comment GET. With ~14k comments this is ~5 minutes wallclock; fine
// for a one-shot backfill.
let commentsDone = 0;
let commentsSkipped = 0;
let commentsFailed = 0;

for (const c of commentMapRows) {
  const [owner, name] = c.source_repo.split("/");
  if (!owner || !name) {
    commentsFailed++;
    continue;
  }
  try {
    const src = await srcGet<SourceComment>(
      `/api/v1/repos/${owner}/${name}/issues/comments/${c.source_comment_id}`
    );
    if (!src) {
      commentsSkipped++;
      continue;
    }
    updComment.run(src.created_at, src.updated_at, c.target_comment_id);
    commentsDone++;
    if (commentsDone % 200 === 0) {
      console.error(`  comments: ${commentsDone}/${commentMapRows.length}`);
    }
  } catch (e) {
    commentsFailed++;
    if (commentsFailed < 10) {
      console.error(`  ! comment ${c.source_repo}:${c.source_comment_id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.error(`\n--- done in ${elapsed}s ---`);
console.error(
  `issues:   ${issuesDone} updated, ${issuesSkipped} skipped, ${issuesFailed} failed`
);
console.error(
  `comments: ${commentsDone} updated, ${commentsSkipped} skipped, ${commentsFailed} failed`
);

ework.close();
ledger.close();
