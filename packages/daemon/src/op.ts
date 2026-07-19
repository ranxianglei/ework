import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger";
import type { TrackerRef, Issue, IssueState, OpSession, SessionState, Message } from "./trackers/types";

// ─── Row Types ───

interface IssueRow {
  id: string;
  tracker_type: string;
  tracker_scope_key: string;
  tracker_scope: string;
  tracker_issue_id: string;
  state: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  issue_id: string;
  name: string;
  state: string;
  opencode_session_id: string | null;
  opencode_pid: number | null;
  workdir: string | null;
  created_at: string;
  started_at: number | null;
  progress_comment_id: string | null;
  reaction_comment_id: string | null;
  current_prompt: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  content: string;
  source_comment_id: string | null;
  reaction_comment_id: string | null;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Row → Domain Mappers ───

function rowToIssue(row: IssueRow): Issue {
  let scope: Record<string, string>;
  try { scope = JSON.parse(row.tracker_scope); } catch { scope = {}; }
  return {
    id: row.id,
    trackerType: row.tracker_type,
    trackerScope: scope,
    trackerScopeKey: row.tracker_scope_key,
    trackerIssueId: row.tracker_issue_id,
    state: row.state as IssueState,
    title: row.title,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToSession(row: SessionRow): OpSession {
  return {
    id: row.id,
    issueId: row.issue_id,
    name: row.name,
    state: row.state as SessionState,
    opencodeSessionId: row.opencode_session_id ?? undefined,
    opencodePid: row.opencode_pid ?? undefined,
    workdir: row.workdir ?? undefined,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ?? undefined,
    progressCommentId: row.progress_comment_id ?? undefined,
    reactionCommentId: row.reaction_comment_id ?? undefined,
    currentPrompt: row.current_prompt ?? undefined,
  };
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    sourceCommentId: row.source_comment_id ?? undefined,
    reactionCommentId: row.reaction_comment_id ?? undefined,
    status: row.status as Message["status"],
    attempts: row.attempts,
    error: row.error ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function sessionToTrackerRef(session: OpSession, issue: Issue): TrackerRef {
  return {
    trackerType: issue.trackerType,
    scope: issue.trackerScope,
    issueId: issue.trackerIssueId,
  };
}

// ─── Store (SQLite DAO) ───

export class Store {
  private db: Database;

  private issueStmts!: {
    getById: ReturnType<Database["prepare"]>;
    getByTrackerRef: ReturnType<Database["prepare"]>;
    insert: ReturnType<Database["prepare"]>;
    updateState: ReturnType<Database["prepare"]>;
    updateTitle: ReturnType<Database["prepare"]>;
    listActive: ReturnType<Database["prepare"]>;
    listAll: ReturnType<Database["prepare"]>;
  };

  private sessionStmts!: {
    getById: ReturnType<Database["prepare"]>;
    getByName: ReturnType<Database["prepare"]>;
    getByIssue: ReturnType<Database["prepare"]>;
    insert: ReturnType<Database["prepare"]>;
    update: ReturnType<Database["prepare"]>;
    listAll: ReturnType<Database["prepare"]>;
    listNonIdle: ReturnType<Database["prepare"]>;
  };

  private msgStmts!: {
    getById: ReturnType<Database["prepare"]>;
    insert: ReturnType<Database["prepare"]>;
    getNextPending: ReturnType<Database["prepare"]>;
    updateStatus: ReturnType<Database["prepare"]>;
    updateStatusSelect: ReturnType<Database["prepare"]>;
    getBySession: ReturnType<Database["prepare"]>;
    getPendingOrRunning: ReturnType<Database["prepare"]>;
    findByCommentId: ReturnType<Database["prepare"]>;
    getRecentBySession: ReturnType<Database["prepare"]>;
  };

  constructor(dbPath?: string) {
    const resolved = dbPath ?? join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "ework-daemon",
      "ework-daemon.db"
    );
    const dir = join(resolved, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(resolved, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.initSchema();
    this.migrateOldSchema();
    this.prepareStatements();
  }

  private initSchema() {
    // Drop old tables with incompatible schemas
    const oldMessages = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
    ).get() as { sql: string } | null;
    if (oldMessages && oldMessages.sql.includes('op_id')) {
      log.info("store: dropping old messages table (incompatible schema)");
      this.db.exec("DROP TABLE messages");
    }
    const oldSessions = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get() as { sql: string } | null;
    if (oldSessions) {
      log.info("store: dropping old sessions table");
      this.db.exec("DROP TABLE IF EXISTS sessions");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        tracker_type TEXT NOT NULL,
        tracker_scope_key TEXT NOT NULL,
        tracker_scope TEXT NOT NULL,
        tracker_issue_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'created',
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tracker_type, tracker_scope_key, tracker_issue_id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS op_sessions (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'idle',
        opencode_session_id TEXT,
        opencode_pid INTEGER,
        workdir TEXT,
        created_at TEXT NOT NULL,
        started_at INTEGER,
        progress_comment_id TEXT,
        reaction_comment_id TEXT,
        current_prompt TEXT,
        UNIQUE(issue_id, name)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES op_sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        source_comment_id TEXT,
        reaction_comment_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_issue ON op_sessions(issue_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)");
  }

  private migrateOldSchema() {
    const hasOldOps = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ops'"
    ).get();
    if (!hasOldOps) return;

    log.info("store: migrating old ops table to issues + op_sessions");

    this.db.exec(`
      INSERT OR IGNORE INTO issues (id, tracker_type, tracker_scope_key, tracker_scope, tracker_issue_id, state, title, created_at, updated_at)
      SELECT
        lower(hex(randomblob(4))),
        tracker_type, tracker_scope_key, tracker_scope, tracker_issue_id,
        CASE WHEN status = 'closed' THEN 'closed' ELSE 'active' END,
        '',
        created_at, last_activity_at
      FROM ops
      WHERE tracker_type IS NOT NULL
    `);

    this.db.exec(`DROP TABLE IF EXISTS ops`);
    this.db.exec(`DROP TABLE IF EXISTS sessions`);
  }

  private prepareStatements() {
    this.issueStmts = {
      getById: this.db.prepare("SELECT * FROM issues WHERE id = ?"),
      getByTrackerRef: this.db.prepare(
        "SELECT * FROM issues WHERE tracker_type = ? AND tracker_scope_key = ? AND tracker_issue_id = ?"
      ),
      insert: this.db.prepare(
        "INSERT OR IGNORE INTO issues (id, tracker_type, tracker_scope_key, tracker_scope, tracker_issue_id, state, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ),
      updateState: this.db.prepare("UPDATE issues SET state = ?, updated_at = ? WHERE id = ?"),
      updateTitle: this.db.prepare("UPDATE issues SET title = ?, updated_at = ? WHERE id = ?"),
      listActive: this.db.prepare("SELECT * FROM issues WHERE state != 'closed'"),
      listAll: this.db.prepare("SELECT * FROM issues"),
    };

    this.sessionStmts = {
      getById: this.db.prepare("SELECT * FROM op_sessions WHERE id = ?"),
      getByName: this.db.prepare(
        "SELECT * FROM op_sessions WHERE issue_id = ? AND name = ?"
      ),
      getByIssue: this.db.prepare(
        "SELECT * FROM op_sessions WHERE issue_id = ? ORDER BY created_at"
      ),
      insert: this.db.prepare(
        "INSERT OR IGNORE INTO op_sessions (id, issue_id, name, state, opencode_session_id, opencode_pid, workdir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ),
      update: this.db.prepare(
        `UPDATE op_sessions SET state = ?, opencode_session_id = ?, opencode_pid = ?, workdir = ?,
         started_at = ?, progress_comment_id = ?, reaction_comment_id = ?, current_prompt = ? WHERE id = ?`
      ),
      listAll: this.db.prepare("SELECT * FROM op_sessions"),
      listNonIdle: this.db.prepare("SELECT * FROM op_sessions WHERE state != 'idle'"),
    };

    this.msgStmts = {
      getById: this.db.prepare("SELECT * FROM messages WHERE id = ?"),
      insert: this.db.prepare(
        "INSERT OR IGNORE INTO messages (id, session_id, content, source_comment_id, reaction_comment_id, status, attempts, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ),
      getNextPending: this.db.prepare(
        "SELECT * FROM messages WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1"
      ),
      updateStatus: this.db.prepare(
        "UPDATE messages SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?"
      ),
      updateStatusSelect: this.db.prepare("SELECT * FROM messages WHERE id = ?"),
      getBySession: this.db.prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC"
      ),
      getPendingOrRunning: this.db.prepare(
        "SELECT * FROM messages WHERE status IN ('pending', 'running') ORDER BY created_at ASC"
      ),
      findByCommentId: this.db.prepare(
        "SELECT * FROM messages WHERE source_comment_id = ?"
      ),
      getRecentBySession: this.db.prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
      ),
    };
  }

  // ─── Issues ───

  getIssue(id: string): Issue | undefined {
    const row = this.issueStmts.getById.get(id) as IssueRow | null;
    return row ? rowToIssue(row) : undefined;
  }

  findIssue(trackerType: string, scopeKey: string, issueId: string): Issue | undefined {
    const row = this.issueStmts.getByTrackerRef.get(trackerType, scopeKey, issueId) as IssueRow | null;
    return row ? rowToIssue(row) : undefined;
  }

  findOrCreateIssue(ref: TrackerRef, scopeKey: string, title: string): Issue {
    const existing = this.findIssue(ref.trackerType, scopeKey, ref.issueId);
    if (existing) {
      if (title && existing.title !== title) {
        this.issueStmts.updateTitle.run(title, new Date().toISOString(), existing.id);
        existing.title = title;
      }
      return existing;
    }

    const now = new Date();
    const id = crypto.randomUUID();
    this.issueStmts.insert.run(
      id, ref.trackerType, scopeKey,
      JSON.stringify(ref.scope), ref.issueId,
      "created", title, now.toISOString(), now.toISOString()
    );

    // Re-read in case INSERT OR IGNORE hit a concurrent insert
    const inserted = this.findIssue(ref.trackerType, scopeKey, ref.issueId);
    if (inserted) return inserted;

    return {
      id, trackerType: ref.trackerType, trackerScope: ref.scope,
      trackerScopeKey: scopeKey, trackerIssueId: ref.issueId,
      state: "created", title, createdAt: now, updatedAt: now,
    };
  }

  updateIssueState(id: string, state: IssueState) {
    this.issueStmts.updateState.run(state, new Date().toISOString(), id);
  }

  listActiveIssues(): Issue[] {
    return (this.issueStmts.listActive.all() as IssueRow[]).map(rowToIssue);
  }

  listAllIssues(): Issue[] {
    return (this.issueStmts.listAll.all() as IssueRow[]).map(rowToIssue);
  }

  // ─── OpSessions ───

  getSession(id: string): OpSession | undefined {
    const row = this.sessionStmts.getById.get(id) as SessionRow | null;
    return row ? rowToSession(row) : undefined;
  }

  getSessionByName(issueId: string, name: string): OpSession | undefined {
    const row = this.sessionStmts.getByName.get(issueId, name) as SessionRow | null;
    return row ? rowToSession(row) : undefined;
  }

  getSessionsForIssue(issueId: string): OpSession[] {
    return (this.sessionStmts.getByIssue.all(issueId) as SessionRow[]).map(rowToSession);
  }

  createSession(issueId: string, name: string): OpSession {
    const existing = this.getSessionByName(issueId, name);
    if (existing) return existing;

    const session: OpSession = {
      id: crypto.randomUUID(),
      issueId,
      name,
      state: "idle",
      createdAt: new Date(),
    };
    this.sessionStmts.insert.run(
      session.id, session.issueId, session.name, session.state,
      null, null, null, session.createdAt.toISOString()
    );
    return session;
  }

  updateSession(id: string, patch: Partial<OpSession>): OpSession | undefined {
    const row = this.sessionStmts.getById.get(id) as SessionRow | null;
    if (!row) return undefined;
    const existing = rowToSession(row);
    const updated = { ...existing, ...patch };

    this.sessionStmts.update.run(
      updated.state,
      updated.opencodeSessionId ?? null,
      updated.opencodePid ?? null,
      updated.workdir ?? null,
      updated.startedAt ?? null,
      updated.progressCommentId ?? null,
      updated.reactionCommentId ?? null,
      updated.currentPrompt ?? null,
      id
    );
    return updated;
  }

  listAllSessions(): OpSession[] {
    return (this.sessionStmts.listAll.all() as SessionRow[]).map(rowToSession);
  }

  listNonIdleSessions(): OpSession[] {
    return (this.sessionStmts.listNonIdle.all() as SessionRow[]).map(rowToSession);
  }

  // ─── Messages ───

  createMessage(sessionId: string, content: string, sourceCommentId?: string, reactionCommentId?: string): Message {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.msgStmts.insert.run(
      id, sessionId, content,
      sourceCommentId ?? null, reactionCommentId ?? null,
      "pending", 0, null, now, now
    );
    return {
      id, sessionId, content, sourceCommentId, reactionCommentId,
      status: "pending", attempts: 0,
      createdAt: new Date(now), updatedAt: new Date(now),
    };
  }

  getMessage(id: string): Message | undefined {
    const row = this.msgStmts.getById.get(id) as MessageRow | null;
    return row ? rowToMessage(row) : undefined;
  }

  getNextPendingMessage(sessionId: string): Message | undefined {
    const row = this.msgStmts.getNextPending.get(sessionId) as MessageRow | null;
    return row ? rowToMessage(row) : undefined;
  }

  updateMessageStatus(id: string, status: Message["status"], error?: string) {
    const row = this.msgStmts.updateStatusSelect.get(id) as MessageRow | null;
    const attempts = row ? row.attempts + (status === "failed" ? 1 : 0) : 0;
    this.msgStmts.updateStatus.run(status, attempts, error ?? null, new Date().toISOString(), id);
  }

  getMessagesForSession(sessionId: string): Message[] {
    return (this.msgStmts.getBySession.all(sessionId) as MessageRow[]).map(rowToMessage);
  }

  getRecentMessages(sessionId: string, limit: number): Message[] {
    return (this.msgStmts.getRecentBySession.all(sessionId, limit) as MessageRow[]).map(rowToMessage);
  }

  getPendingOrRunningMessages(): Message[] {
    return (this.msgStmts.getPendingOrRunning.all() as MessageRow[]).map(rowToMessage);
  }

  findMessageByCommentId(commentId: string): Message | undefined {
    const row = this.msgStmts.findByCommentId.get(commentId) as MessageRow | null;
    return row ? rowToMessage(row) : undefined;
  }

  close() {
    this.db.close();
  }
}
