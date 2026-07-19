/**
 * Issue Tracker Abstraction Layer.
 * Three-entity model: Issue → OpSession → Process
 */

// ─── Core Data Types ───

/** Tracker-agnostic issue reference */
export interface TrackerRef {
  trackerType: string;
  scope: Record<string, string>;
  issueId: string;
}

/** Parsed, tracker-agnostic webhook event */
export type TrackerEventType = "issue_opened" | "comment_created" | "issue_closed";

export interface TrackerEvent {
  type: TrackerEventType;
  ref: TrackerRef;
  issue: {
    title: string;
    body: string;
    state: string;
    author: string;
  };
  comment?: {
    id: string;
    body: string;
    author: string;
  };
}

/** Tracker-agnostic comment */
export interface TrackerComment {
  id: string;
  body: string;
  author: string;
  createdAt?: string; // ISO timestamp
}

/** Context injected into opencode prompts */
export interface TrackerInstructions {
  clone: string;
  issueRef: string;
  closeIssue?: string;
}

// ─── Three-Entity Model ───

export type IssueState = "created" | "active" | "closed";

/** Issue = tracker resource with cyclic lifecycle (created → active → closed → active) */
export interface Issue {
  id: string;
  trackerType: string;
  trackerScope: Record<string, string>;
  trackerScopeKey: string;
  trackerIssueId: string;
  state: IssueState;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionState = "idle" | "running";

/** OpSession = persistent agent binding to one issue. Never destroyed. */
export interface OpSession {
  id: string;
  issueId: string;
  name: string;
  state: SessionState;
  opencodeSessionId?: string;
  opencodePid?: number;
  workdir?: string;
  createdAt: Date;
  // Runtime state (persisted for crash recovery)
  startedAt?: number;
  progressCommentId?: string;
  reactionCommentId?: string;
  currentPrompt?: string;
}

/** Message = a prompt enqueued for a session */
export interface Message {
  id: string;
  sessionId: string;
  content: string;
  sourceCommentId?: string;
  reactionCommentId?: string;
  status: "pending" | "running" | "done" | "failed" | "interrupted";
  attempts: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Adapter Interface ───

export interface IssueTracker {
  readonly type: string;

  formatScopeKey(scope: Record<string, string>): string;

  createComment(ref: TrackerRef, body: string): Promise<{ id: string }>;
  editComment(ref: TrackerRef, commentId: string, body: string): Promise<void>;
  deleteComment(ref: TrackerRef, commentId: string): Promise<void>;
  listComments(ref: TrackerRef): Promise<TrackerComment[]>;
  closeIssue(ref: TrackerRef): Promise<void>;

  setReaction(ref: TrackerRef, commentId: string, content: string, remove?: boolean): Promise<void>;

  getTrackerInstructions(ref: TrackerRef): TrackerInstructions;

  verifyWebhookSignature(rawBody: string, headers: Record<string, string | null>): boolean;
  parseWebhookEvent(rawBody: string): TrackerEvent | null;

  isBotUser(userIdentifier: string): boolean;
}

// ─── Runtime Key Format ───

/**
 * Runtime key: `trackerType:scopeKey#issueId@sessionName`
 *   gitea:owner/repo#123@ework-daemon
 *   plane:test-ws/proj-uuid#wi-456@ework-daemon
 * Keys are NEVER stored in DB — purely runtime Map/Set indices.
 */
export function formatKey(trackerType: string, scopeKey: string, issueId: string, sessionName: string): string {
  return `${trackerType}:${scopeKey}#${issueId}@${sessionName}`;
}

export interface ParsedKey {
  trackerType: string;
  scopeKey: string;
  issueId: string;
  sessionName: string;
}

export function parseKey(k: string): ParsedKey | null {
  const colonIdx = k.indexOf(":");
  const hashIdx = k.lastIndexOf("#");
  const atIdx = k.lastIndexOf("@");
  if (colonIdx < 0 || hashIdx < 0 || atIdx < 0) return null;
  if (colonIdx > hashIdx || hashIdx > atIdx) return null;

  const trackerType = k.slice(0, colonIdx);
  const scopeKey = k.slice(colonIdx + 1, hashIdx);
  const issueId = k.slice(hashIdx + 1, atIdx);
  const sessionName = k.slice(atIdx + 1);

  if (!trackerType || !scopeKey || !issueId || !sessionName) return null;
  return { trackerType, scopeKey, issueId, sessionName };
}
