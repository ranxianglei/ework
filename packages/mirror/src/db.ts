import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: Database;

export function initDB(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_map (
      ework_project_owner TEXT NOT NULL,
      ework_project_name  TEXT NOT NULL,
      ework_issue_num     INTEGER NOT NULL,
      gitea_owner         TEXT NOT NULL,
      gitea_repo          TEXT NOT NULL,
      gitea_issue_num     INTEGER NOT NULL,
      ework_issue_title   TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      PRIMARY KEY (ework_project_owner, ework_project_name, ework_issue_num)
    );
    CREATE INDEX IF NOT EXISTS issue_map_by_gitea
      ON issue_map (gitea_owner, gitea_repo, gitea_issue_num);

    CREATE TABLE IF NOT EXISTS comment_map (
      ework_comment_id  INTEGER PRIMARY KEY,
      ework_project_owner TEXT NOT NULL,
      ework_project_name  TEXT NOT NULL,
      ework_issue_num   INTEGER NOT NULL,
      gitea_owner       TEXT NOT NULL,
      gitea_repo        TEXT NOT NULL,
      gitea_issue_num   INTEGER NOT NULL,
      gitea_comment_id  INTEGER NOT NULL,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at       TEXT NOT NULL,
      event             TEXT NOT NULL,
      action            TEXT,
      ework_project     TEXT,
      ework_issue       INTEGER,
      ework_comment     INTEGER,
      gitea_target      TEXT,
      outcome           TEXT NOT NULL,
      detail            TEXT
    );
  `);
}

export interface IssueMapRow {
  ework_project_owner: string;
  ework_project_name: string;
  ework_issue_num: number;
  gitea_owner: string;
  gitea_repo: string;
  gitea_issue_num: number;
  ework_issue_title: string;
}

export function getIssueMap(
  owner: string,
  name: string,
  issueNum: number
): IssueMapRow | null {
  const row = db
    .query(
      `SELECT ework_project_owner, ework_project_name, ework_issue_num,
              gitea_owner, gitea_repo, gitea_issue_num, ework_issue_title
       FROM issue_map
       WHERE ework_project_owner = ? AND ework_project_name = ? AND ework_issue_num = ?`
    )
    .get(owner, name, issueNum) as IssueMapRow | undefined;
  return row ?? null;
}

export function recordIssueMap(row: IssueMapRow & { created_at?: string }): void {
  const ts = row.created_at ?? new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO issue_map
       (ework_project_owner, ework_project_name, ework_issue_num,
        gitea_owner, gitea_repo, gitea_issue_num, ework_issue_title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.ework_project_owner,
    row.ework_project_name,
    row.ework_issue_num,
    row.gitea_owner,
    row.gitea_repo,
    row.gitea_issue_num,
    row.ework_issue_title,
    ts
  );
}

export interface CommentMapRow {
  ework_comment_id: number;
  gitea_comment_id: number;
}

export function getCommentMap(eworkCommentId: number): CommentMapRow | null {
  const row = db
    .query(
      `SELECT ework_comment_id, gitea_comment_id FROM comment_map WHERE ework_comment_id = ?`
    )
    .get(eworkCommentId) as CommentMapRow | undefined;
  return row ?? null;
}

export function recordCommentMap(args: {
  eworkCommentId: number;
  eworkProjectOwner: string;
  eworkProjectName: string;
  eworkIssueNum: number;
  giteaOwner: string;
  giteaRepo: string;
  giteaIssueNum: number;
  giteaCommentId: number;
}): void {
  const ts = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO comment_map
       (ework_comment_id, ework_project_owner, ework_project_name, ework_issue_num,
        gitea_owner, gitea_repo, gitea_issue_num, gitea_comment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.eworkCommentId,
    args.eworkProjectOwner,
    args.eworkProjectName,
    args.eworkIssueNum,
    args.giteaOwner,
    args.giteaRepo,
    args.giteaIssueNum,
    args.giteaCommentId,
    ts
  );
}

export interface EventLogEntry {
  event: string;
  action?: string | null;
  ework_project?: string | null;
  ework_issue?: number | null;
  ework_comment?: number | null;
  gitea_target?: string | null;
  outcome: string;
  detail?: string | null;
}

export function logEvent(entry: EventLogEntry): void {
  try {
    db.query(
      `INSERT INTO event_log
         (received_at, event, action, ework_project, ework_issue, ework_comment,
          gitea_target, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(),
      entry.event,
      entry.action ?? null,
      entry.ework_project ?? null,
      entry.ework_issue ?? null,
      entry.ework_comment ?? null,
      entry.gitea_target ?? null,
      entry.outcome,
      entry.detail ?? null
    );
  } catch {
    // Observability-only; swallow — request must not fail because logging did.
  }
}

export interface MirrorTarget {
  giteaOwner: string;
  giteaRepo: string;
}
