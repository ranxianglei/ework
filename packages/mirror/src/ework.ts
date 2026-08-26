export type WebhookEventName = "issues" | "issue_comment";
export type IssueAction = "opened" | "closed" | "reopened";

interface PayloadUser {
  login: string;
  id?: number;
}

interface PayloadRepo {
  name: string;
  owner?: PayloadUser;
  full_name?: string;
  // Resolved model (issue > project > global) the daemon spawned with;
  // absent when no override is configured anywhere.
  ework_model?: string;
}

interface PayloadIssue {
  id?: number;
  number: number;
  upstream_issue_number?: number | null;
  title: string;
  body?: string;
  state?: "open" | "closed";
  user?: PayloadUser;
  created_at?: string;
  html_url?: string;
}

interface PayloadComment {
  id: number;
  body: string;
  user?: PayloadUser;
  created_at?: string;
}

export interface ParsedIssueEvent {
  kind: "issues";
  action: IssueAction;
  projectOwner: string;
  projectName: string;
  issue: PayloadIssue;
  senderLogin: string;
  model?: string | undefined;
}

export interface ParsedCommentEvent {
  kind: "issue_comment";
  action: "created";
  projectOwner: string;
  projectName: string;
  issue: PayloadIssue;
  comment: PayloadComment;
  senderLogin: string;
  model?: string | undefined;
}

export type ParsedEvent = ParsedIssueEvent | ParsedCommentEvent;

export class ParseError extends Error {}

export function parseEvent(
  rawBody: string,
  eventHeader: string
): ParsedEvent {
  if (eventHeader !== "issues" && eventHeader !== "issue_comment") {
    throw new ParseError(`unsupported event: ${eventHeader}`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new ParseError("payload is not JSON");
  }
  const action = payload.action;
  if (typeof action !== "string") {
    throw new ParseError("missing action");
  }
  const repo = payload.repository as PayloadRepo | undefined;
  if (!repo || typeof repo !== "object") {
    throw new ParseError("missing repository");
  }
  const issue = payload.issue as PayloadIssue | undefined;
  if (!issue || typeof issue !== "object" || typeof issue.number !== "number") {
    throw new ParseError("missing issue.number");
  }
  const ownerLogin = repo.owner?.login;
  if (!ownerLogin) throw new ParseError("missing repository.owner.login");

  const senderLogin =
    (payload.sender as PayloadUser | undefined)?.login ??
    issue.user?.login ??
    "";

  if (eventHeader === "issues") {
    if (action !== "opened" && action !== "closed" && action !== "reopened") {
      throw new ParseError(`unsupported issues action: ${action}`);
    }
    return {
      kind: "issues",
      action,
      projectOwner: ownerLogin,
      projectName: repo.name,
      issue,
      senderLogin,
      model: repo.ework_model,
    };
  }

  if (action !== "created") {
    throw new ParseError(`unsupported issue_comment action: ${action}`);
  }
  const comment = payload.comment as PayloadComment | undefined;
  if (!comment || typeof comment.id !== "number") {
    throw new ParseError("missing comment.id");
  }
  return {
    kind: "issue_comment",
    action: "created",
    projectOwner: ownerLogin,
    projectName: repo.name,
    issue,
    comment,
    senderLogin: comment.user?.login ?? senderLogin,
    model: repo.ework_model,
  };
}
