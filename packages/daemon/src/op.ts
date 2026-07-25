import { log } from "./logger";
import { getDB } from "./db";
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
  owner_daemon_id: number | null;
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
  last_output_at: string | null;
  nudge_rounds: number;
  stuck_nudge_rounds: number;
  generation: number;
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
    ownerDaemonId: row.owner_daemon_id ?? null,
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
    lastOutputAt: row.last_output_at ? new Date(row.last_output_at).getTime() : undefined,
    nudgeRounds: row.nudge_rounds ?? 0,
    stuckNudgeRounds: row.stuck_nudge_rounds ?? 0,
    generation: row.generation ?? 0,
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

// ─── Store (async DAO over the global AsyncDatabase from db.ts) ───

export class Store {
  // No constructor work: the DB is opened globally by initDB() at boot.
  // Tests rely on tests/setup.ts to call initDB() in beforeAll.

  // ─── Issues ───

  async getIssue(id: string): Promise<Issue | undefined> {
    const row = await getDB().get<IssueRow>("SELECT * FROM {{issues}} WHERE id = ?", [id]);
    return row ? rowToIssue(row) : undefined;
  }

  async findIssue(trackerType: string, scopeKey: string, issueId: string): Promise<Issue | undefined> {
    const row = await getDB().get<IssueRow>(
      "SELECT * FROM {{issues}} WHERE tracker_type = ? AND tracker_scope_key = ? AND tracker_issue_id = ?",
      [trackerType, scopeKey, issueId]
    );
    return row ? rowToIssue(row) : undefined;
  }

  async findOrCreateIssue(ref: TrackerRef, scopeKey: string, title: string): Promise<Issue> {
    const existing = await this.findIssue(ref.trackerType, scopeKey, ref.issueId);
    if (existing) {
      if (title && existing.title !== title) {
        await getDB().run("UPDATE {{issues}} SET title = ?, updated_at = ? WHERE id = ?", [
          title,
          new Date().toISOString(),
          existing.id,
        ]);
        existing.title = title;
      }
      return existing;
    }

    const now = new Date();
    const id = crypto.randomUUID();
    await getDB().run(
      "INSERT OR IGNORE INTO {{issues}} (id, tracker_type, tracker_scope_key, tracker_scope, tracker_issue_id, state, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ref.trackerType, scopeKey, JSON.stringify(ref.scope), ref.issueId, "created", title, now.toISOString(), now.toISOString()]
    );

    // Re-read in case INSERT OR IGNORE hit a concurrent insert
    const inserted = await this.findIssue(ref.trackerType, scopeKey, ref.issueId);
    if (inserted) return inserted;

    return {
      id, trackerType: ref.trackerType, trackerScope: ref.scope,
      trackerScopeKey: scopeKey, trackerIssueId: ref.issueId,
      state: "created", title, createdAt: now, updatedAt: now,
    };
  }

  async updateIssueState(id: string, state: IssueState): Promise<void> {
    await getDB().run("UPDATE {{issues}} SET state = ?, updated_at = ? WHERE id = ?", [
      state,
      new Date().toISOString(),
      id,
    ]);
  }

  async listActiveIssues(): Promise<Issue[]> {
    const rows = await getDB().all<IssueRow>("SELECT * FROM {{issues}} WHERE state != 'closed'");
    return rows.map(rowToIssue);
  }

  async listAllIssues(): Promise<Issue[]> {
    const rows = await getDB().all<IssueRow>("SELECT * FROM {{issues}}");
    return rows.map(rowToIssue);
  }

  // ─── OpSessions ───

  async getSession(id: string): Promise<OpSession | undefined> {
    const row = await getDB().get<SessionRow>("SELECT * FROM {{op_sessions}} WHERE id = ?", [id]);
    return row ? rowToSession(row) : undefined;
  }

  async getSessionByName(issueId: string, name: string): Promise<OpSession | undefined> {
    const row = await getDB().get<SessionRow>(
      "SELECT * FROM {{op_sessions}} WHERE issue_id = ? AND name = ?",
      [issueId, name]
    );
    return row ? rowToSession(row) : undefined;
  }

  async getSessionsForIssue(issueId: string): Promise<OpSession[]> {
    const rows = await getDB().all<SessionRow>(
      "SELECT * FROM {{op_sessions}} WHERE issue_id = ? ORDER BY created_at",
      [issueId]
    );
    return rows.map(rowToSession);
  }

  async createSession(issueId: string, name: string): Promise<OpSession> {
    const existing = await this.getSessionByName(issueId, name);
    if (existing) return existing;

    const session: OpSession = {
      id: crypto.randomUUID(),
      issueId,
      name,
      state: "idle",
      createdAt: new Date(),
    };
    await getDB().run(
      "INSERT OR IGNORE INTO {{op_sessions}} (id, issue_id, name, state, opencode_session_id, opencode_pid, workdir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [session.id, session.issueId, session.name, session.state, null, null, null, session.createdAt.toISOString()]
    );
    return session;
  }

  async updateSession(id: string, patch: Partial<OpSession>): Promise<OpSession | undefined> {
    const row = await getDB().get<SessionRow>("SELECT * FROM {{op_sessions}} WHERE id = ?", [id]);
    if (!row) return undefined;
    const existing = rowToSession(row);
    const updated = { ...existing, ...patch };

    await getDB().run(
      `UPDATE {{op_sessions}} SET state = ?, opencode_session_id = ?, opencode_pid = ?, workdir = ?,
       started_at = ?, progress_comment_id = ?, reaction_comment_id = ?, current_prompt = ?,
       last_output_at = ?, nudge_rounds = ?, stuck_nudge_rounds = ?, generation = ? WHERE id = ?`,
      [
        updated.state,
        updated.opencodeSessionId ?? null,
        updated.opencodePid ?? null,
        updated.workdir ?? null,
        updated.startedAt ?? null,
        updated.progressCommentId ?? null,
        updated.reactionCommentId ?? null,
        updated.currentPrompt ?? null,
        updated.lastOutputAt != null ? new Date(updated.lastOutputAt).toISOString() : null,
        updated.nudgeRounds ?? 0,
        updated.stuckNudgeRounds ?? 0,
        updated.generation ?? 0,
        id,
      ]
    );
    return updated;
  }

  async listAllSessions(): Promise<OpSession[]> {
    const rows = await getDB().all<SessionRow>("SELECT * FROM {{op_sessions}}");
    return rows.map(rowToSession);
  }

  async listNonIdleSessions(): Promise<OpSession[]> {
    const rows = await getDB().all<SessionRow>("SELECT * FROM {{op_sessions}} WHERE state != 'idle'");
    return rows.map(rowToSession);
  }

  // ─── Messages ───

  async createMessage(
    sessionId: string,
    content: string,
    sourceCommentId?: string,
    reactionCommentId?: string,
    model?: string,
  ): Promise<Message> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await getDB().run(
      "INSERT OR IGNORE INTO {{messages}} (id, session_id, content, source_comment_id, reaction_comment_id, status, attempts, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, sessionId, content, sourceCommentId ?? null, reactionCommentId ?? null, "pending", 0, null, now, now]
    );
    return {
      id, sessionId, content, sourceCommentId, reactionCommentId,
      status: "pending", attempts: 0,
      createdAt: new Date(now), updatedAt: new Date(now),
      model,
    };
  }

  async getMessage(id: string): Promise<Message | undefined> {
    const row = await getDB().get<MessageRow>("SELECT * FROM {{messages}} WHERE id = ?", [id]);
    return row ? rowToMessage(row) : undefined;
  }

  async getNextPendingMessage(sessionId: string): Promise<Message | undefined> {
    const row = await getDB().get<MessageRow>(
      "SELECT * FROM {{messages}} WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1",
      [sessionId]
    );
    return row ? rowToMessage(row) : undefined;
  }

  async updateMessageStatus(id: string, status: Message["status"], error?: string): Promise<void> {
    const row = await getDB().get<MessageRow>("SELECT * FROM {{messages}} WHERE id = ?", [id]);
    const attempts = row ? row.attempts + (status === "failed" ? 1 : 0) : 0;
    await getDB().run(
      "UPDATE {{messages}} SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?",
      [status, attempts, error ?? null, new Date().toISOString(), id]
    );
  }

  async getMessagesForSession(sessionId: string): Promise<Message[]> {
    const rows = await getDB().all<MessageRow>(
      "SELECT * FROM {{messages}} WHERE session_id = ? ORDER BY created_at DESC",
      [sessionId]
    );
    return rows.map(rowToMessage);
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const rows = await getDB().all<MessageRow>(
      "SELECT * FROM {{messages}} WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
      [sessionId, limit]
    );
    return rows.map(rowToMessage);
  }

  async getPendingOrRunningMessages(): Promise<Message[]> {
    const rows = await getDB().all<MessageRow>(
      "SELECT * FROM {{messages}} WHERE status IN ('pending', 'running') ORDER BY created_at ASC"
    );
    return rows.map(rowToMessage);
  }

  async findMessageByCommentId(commentId: string): Promise<Message | undefined> {
    const row = await getDB().get<MessageRow>(
      "SELECT * FROM {{messages}} WHERE source_comment_id = ?",
      [commentId]
    );
    return row ? rowToMessage(row) : undefined;
  }

  // ─── Multi-machine coordination (Phase 1) ───
  //
  // daemon_id is a DB-allocated logical slot. A restarted daemon ADOPTS the
  // oldest orphan slot (last_heartbeat older than the lease TTL) instead of
  // inserting a new row — so a daemon that crashes + restarts reclaims its
  // previous id (and thus its owned issues) rather than leaving them stuck
  // until releaseDeadOwners runs.

  /** Register this daemon, adopting an orphan slot if available. */
  async registerDaemon(
    displayName: string,
    endpoint: string,
    capacity: number,
    leaseTtlMs: number,
  ): Promise<number> {
    const db = getDB();
    const cutoff = new Date(Date.now() - leaseTtlMs).toISOString();

    const orphan = await db.get<{ id: number }>(
      "SELECT id FROM {{daemons}} WHERE last_heartbeat < ? ORDER BY last_heartbeat LIMIT 1",
      [cutoff]
    );
    if (orphan) {
      const now = new Date().toISOString();
      const res = await db.run(
        "UPDATE {{daemons}} SET display_name = ?, internal_endpoint = ?, last_heartbeat = ?, status = 'active' WHERE id = ? AND last_heartbeat < ?",
        [displayName, endpoint, now, orphan.id, cutoff]
      );
      if (res.changes === 1) return orphan.id;
    }

    const now = new Date().toISOString();
    const ins = await db.run(
      "INSERT INTO {{daemons}} (display_name, internal_endpoint, capacity, last_heartbeat, registered_at, status) VALUES (?, ?, ?, ?, ?, 'active')",
      [displayName, endpoint, capacity, now, now]
    );
    return ins.insertId;
  }

  async heartbeat(daemonId: number): Promise<void> {
    await getDB().run(
      "UPDATE {{daemons}} SET last_heartbeat = ? WHERE id = ?",
      [new Date().toISOString(), daemonId]
    );
  }

  async markDaemonStatus(daemonId: number, status: "active" | "drained" | "dead"): Promise<void> {
    await getDB().run(
      "UPDATE {{daemons}} SET status = ? WHERE id = ?",
      [status, daemonId]
    );
  }

  /** Clear owner_daemon_id on issues whose daemon has missed the lease. */
  async releaseDeadOwners(leaseTtlMs: number): Promise<number> {
    const db = getDB();
    const cutoff = new Date(Date.now() - leaseTtlMs).toISOString();
    const res = await db.run(
      "UPDATE {{issues}} SET owner_daemon_id = NULL WHERE owner_daemon_id IN (SELECT id FROM {{daemons}} WHERE last_heartbeat < ?)",
      [cutoff]
    );
    return res.changes;
  }

  /**
   * Atomic claim: affected_rows decides the winner. Returns true iff this
   * daemon won the race. Re-claiming an issue you already own also returns
   * false (the WHERE requires owner IS NULL) — call sites check ownership
   * first when they need to handle the "already mine" case.
   */
  async claimIssue(issueId: string, daemonId: number): Promise<boolean> {
    const res = await getDB().run(
      "UPDATE {{issues}} SET owner_daemon_id = ? WHERE id = ? AND owner_daemon_id IS NULL",
      [daemonId, issueId]
    );
    return res.changes === 1;
  }

  /** First-boot migration: claim all pre-existing ownerless issues. */
  async claimAllOwnerless(daemonId: number): Promise<number> {
    const res = await getDB().run(
      "UPDATE {{issues}} SET owner_daemon_id = ? WHERE owner_daemon_id IS NULL",
      [daemonId]
    );
    return res.changes;
  }

  /** Atomic message claim: pending → running. False = lost or already done. */
  async claimMessage(messageId: string): Promise<boolean> {
    const res = await getDB().run(
      "UPDATE {{messages}} SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'",
      [new Date().toISOString(), messageId]
    );
    return res.changes === 1;
  }

  async listOwnedIssues(daemonId: number): Promise<Issue[]> {
    const rows = await getDB().all<IssueRow>(
      "SELECT * FROM {{issues}} WHERE owner_daemon_id = ?",
      [daemonId]
    );
    return rows.map(rowToIssue);
  }

  async listOwnedSessions(daemonId: number): Promise<OpSession[]> {
    const rows = await getDB().all<SessionRow>(
      `SELECT s.* FROM {{op_sessions}} s
       INNER JOIN {{issues}} i ON i.id = s.issue_id
       WHERE i.owner_daemon_id = ?
       ORDER BY s.created_at`,
      [daemonId]
    );
    return rows.map(rowToSession);
  }

  /** Scoped variant of getPendingOrRunningMessages: only this daemon's issues. */
  async getOwnedPendingOrRunningMessages(daemonId: number): Promise<Message[]> {
    const rows = await getDB().all<MessageRow>(
      `SELECT m.* FROM {{messages}} m
       INNER JOIN {{op_sessions}} s ON s.id = m.session_id
       INNER JOIN {{issues}} i ON i.id = s.issue_id
       WHERE i.owner_daemon_id = ? AND m.status IN ('pending', 'running')
       ORDER BY m.created_at ASC`,
      [daemonId]
    );
    return rows.map(rowToMessage);
  }

  async close(): Promise<void> {
    // The DB singleton is owned by db.ts; callers close it via shutdown of the
    // driver there. This method is retained for API compatibility (tests,
    // index.ts shutdown) and is a no-op now.
    log.debug("store.close() is a no-op; DB lifecycle is managed by db.ts");
  }
}
