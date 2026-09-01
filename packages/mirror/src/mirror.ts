import { isGithubTarget, type Config } from "./config";
import {
  getIssueMap,
  recordIssueMap,
  getCommentMap,
  recordCommentMap,
  hasReacted,
  markReacted,
  logEvent,
  type IssueMapRow,
} from "./db";
import {
  createIssue,
  addComment,
  addReaction,
  patchIssueState,
  getRepo,
  GiteaApiError,
  type GiteaRepo,
} from "./giteaClient";
import type {
  ParsedIssueEvent,
  ParsedCommentEvent,
} from "./ework";

export const OUTCOME_SKIPPED_SELF = "skipped:self";
export const OUTCOME_SKIPPED_NO_REPO = "skipped:no_gitea_repo";
export const OUTCOME_SKIPPED_DUPLICATE = "skipped:duplicate";
export const OUTCOME_MIRRORED = "mirrored";
export const OUTCOME_ERROR = "error";

function isSelfEmitter(senderLogin: string, cfg: Config): boolean {
  if (senderLogin === cfg.GITEA_ACT_AS) return true;
  const skip = cfg.SKIP_AUTHOR_LOGINS.split(",").map((x) => x.trim()).filter(Boolean);
  return skip.includes(senderLogin);
}

const MIRROR_MARKER = "\n\n<!-- ework-mirror -->";

// Issues imported from the upstream keep its numbering; mirror in place
// instead of creating a retroactive twin on the target.
// Events carrying these markers/ids originated on the upstream host and were
// imported by ework's sync engine — writing them back would duplicate content
// on the upstream thread.
const UPSTREAM_SYNC_MARKER = "<!-- upstream-sync -->";

// Echo guard. Comments are mirrored only when NOT imported: imports carry the
// upstream-sync marker in the body AND the upstream_comment_id payload field.
// The issue-level upstream number must NOT suppress comments — AI replies and
// local discussion on imported issues must mirror. It only stops mirroring an
// imported issue's "opened" (no twin creation).
export function isImportedComment(ev: {
  comment?: { body?: string; upstream_comment_id?: number | null };
}): boolean {
  return (
    (ev.comment?.body ?? "").includes(UPSTREAM_SYNC_MARKER) ||
    ev.comment?.upstream_comment_id != null
  );
}

export function isImportedIssue<T extends { issue: { upstream_issue_number?: number | null } }>(ev: T): boolean {
  return ev.issue.upstream_issue_number != null;
}

export function upstreamMap(ev: { projectOwner: string; projectName: string; issue: { number: number; upstream_issue_number?: number | null; title?: string | null } }, repo: { owner: string; repo: string }): IssueMapRow | null {
  const up = (ev.issue as any).upstream_issue_number;
  if (typeof up !== "number" || !Number.isFinite(up)) return null;
  const existing = getIssueMap(ev.projectOwner, ev.projectName, ev.issue.number);
  if (existing) return existing;
  const row: IssueMapRow = {
    ework_project_owner: ev.projectOwner,
    ework_project_name: ev.projectName,
    ework_issue_num: ev.issue.number,
    gitea_owner: repo.owner,
    gitea_repo: repo.repo,
    gitea_issue_num: up,
    ework_issue_title: ev.issue.title ?? "",
  };
  recordIssueMap({ ...row, created_at: new Date().toISOString() });
  return row;
}

async function ensureGiteaRepo(
  cfg: Config,
  owner: string,
  name: string
): Promise<GiteaRepo | null> {
  try {
    const r = await getRepo(cfg, owner, name);
    if (r) return { owner, repo: name };
    return null;
  } catch (e) {
    if (e instanceof GiteaApiError && e.status === 404) return null;
    throw e;
  }
}

export function mirrorFooter(issueNum: number): string {
  return `\n\n---\n_Mirrored from ework issue #${issueNum}_${MIRROR_MARKER}`;
}

export function agentLogins(cfg: Config): string[] {
  return (cfg.WORK_AGENT_LOGINS || "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Visible provenance badge: upstream readers see agent output relayed under
// the human account's name — it LEADS the body so the speaker is known
// before reading. Model comes from the webhook payload's resolved override.
export function shortModelName(model: string): string {
  return model.split("/").filter(Boolean).pop() ?? model;
}

export function agentBadgeText(model?: string): string {
  const m = (model || "").trim();
  return m ? `> 🤖 ework agent · ${shortModelName(m)}\n\n` : `> 🤖 ework agent\n\n`;
}

function issueBadge(
  cfg: Config,
  ev: Pick<ParsedIssueEvent, "issue"> & { model?: string | undefined }
): string {
  return agentLogins(cfg).includes(ev.issue.user?.login ?? "")
    ? agentBadgeText(ev.model)
    : "";
}

// Outbound hygiene: nothing that identifies this deployment's network may
// reach the public upstream — RFC1918/ULA addresses are always redacted, plus
// any hostnames listed in WORK_SCRUB_HOSTS.
const IP_PATTERNS: Array<[RegExp, string]> = [
  [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[internal-ip]"],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "[internal-ip]"],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "[internal-ip]"],
  [/\b(?:f[cd][0-9a-f]{2}):(?:[0-9a-f]{1,4}:){2,7}(?:[0-9a-f]{1,4}|[0-9a-f]{0,4}:[0-9a-f]{1,4})\b/gi, "[internal-ip6]"],
  [/\bfe80(?::[0-9a-f]{0,4})+\b/gi, "[internal-ip6]"],
];

export function parseUpstreamAck(body: string): number | null {
  const m = body.match(/<!-- upstream-comment: (\d+) -->/);
  return m ? Number(m[1]) : null;
}

export function scrubInternalRefs(text: string, cfg: Config): string {
  const hostPatterns: Array<[RegExp, string]> = (cfg.WORK_SCRUB_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => [new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "[internal-host]"] as [RegExp, string]);
  return [...IP_PATTERNS, ...hostPatterns].reduce((acc, [re, sub]) => acc.replace(re, sub), text);
}

export async function handleIssueEvent(
  cfg: Config,
  eworkOrigin: string,
  ev: ParsedIssueEvent
): Promise<void> {
  const projectKey = `${ev.projectOwner}/${ev.projectName}`;
  const giteaTarget = `${ev.projectOwner}/${ev.projectName}`;

  if (isSelfEmitter(ev.senderLogin, cfg)) {
    logEvent({
      event: "issues",
      action: ev.action,
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_SELF,
      detail: `sender=${ev.senderLogin}`,
    });
    return;
  }

  if (ev.action === "opened" && isImportedIssue(ev)) {
    logEvent({
      event: "issues",
      action: ev.action,
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_SELF,
      detail: "synced-from-upstream",
    });
    return;
  }

  const repo = await ensureGiteaRepo(cfg, ev.projectOwner, ev.projectName);
  if (!repo) {
    logEvent({
      event: "issues",
      action: ev.action,
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_NO_REPO,
    });
    return;
  }

  try {
    if (ev.action === "opened") {
      const existing = upstreamMap(ev, repo) ?? getIssueMap(ev.projectOwner, ev.projectName, ev.issue.number);
      if (existing) {
        logEvent({
          event: "issues",
          action: ev.action,
          ework_project: projectKey,
          ework_issue: ev.issue.number,
          gitea_target: giteaTarget,
          outcome: OUTCOME_SKIPPED_DUPLICATE,
        });
        return;
      }
      const created = await createIssue(
        cfg,
        repo,
        ev.issue.title,
        issueBadge(cfg, ev) +
          scrubInternalRefs(ev.issue.body ?? "", cfg) +
          mirrorFooter(ev.issue.number)
      );
      recordIssueMap({
        ework_project_owner: ev.projectOwner,
        ework_project_name: ev.projectName,
        ework_issue_num: ev.issue.number,
        gitea_owner: repo.owner,
        gitea_repo: repo.repo,
        gitea_issue_num: created.number,
        ework_issue_title: ev.issue.title,
      });
      logEvent({
        event: "issues",
        action: ev.action,
        ework_project: projectKey,
        ework_issue: ev.issue.number,
        gitea_target: `${giteaTarget}#${created.number}`,
        outcome: OUTCOME_MIRRORED,
      });
      return;
    }

    const map =
      upstreamMap(ev, repo) ?? getIssueMap(ev.projectOwner, ev.projectName, ev.issue.number);
    if (!map) {
      const created = await createIssue(
        cfg,
        repo,
        ev.issue.title,
        `(retroactive mirror for state=${ev.action})\n\n` +
          issueBadge(cfg, ev) +
          scrubInternalRefs(ev.issue.body ?? "", cfg) +
          mirrorFooter(ev.issue.number)
      );
      recordIssueMap({
        ework_project_owner: ev.projectOwner,
        ework_project_name: ev.projectName,
        ework_issue_num: ev.issue.number,
        gitea_owner: repo.owner,
        gitea_repo: repo.repo,
        gitea_issue_num: created.number,
        ework_issue_title: ev.issue.title,
      });
      const desiredState = ev.action === "closed" ? "closed" : "open";
      if (desiredState === "closed") {
        await patchIssueState(cfg, repo, created.number, "closed");
      }
      logEvent({
        event: "issues",
        action: ev.action,
        ework_project: projectKey,
        ework_issue: ev.issue.number,
        gitea_target: `${giteaTarget}#${created.number}`,
        outcome: OUTCOME_MIRRORED,
        detail: "retroactive",
      });
      return;
    }

    const desiredState: "open" | "closed" = ev.action === "closed" ? "closed" : "open";
    await patchIssueState(cfg, repo, map.gitea_issue_num, desiredState);
    logEvent({
      event: "issues",
      action: ev.action,
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      gitea_target: `${giteaTarget}#${map.gitea_issue_num}`,
      outcome: OUTCOME_MIRRORED,
    });
  } catch (e) {
    logEvent({
      event: "issues",
      action: ev.action,
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      gitea_target: giteaTarget,
      outcome: OUTCOME_ERROR,
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
    throw e;
  }
}

export async function handleCommentEvent(
  cfg: Config,
  eworkOrigin: string,
  ev: ParsedCommentEvent
): Promise<void> {
  const projectKey = `${ev.projectOwner}/${ev.projectName}`;
  const giteaTarget = `${ev.projectOwner}/${ev.projectName}`;

  if (isSelfEmitter(ev.senderLogin, cfg)) {
    logEvent({
      event: "issue_comment",
      action: "created",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      ework_comment: ev.comment.id,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_SELF,
      detail: `sender=${ev.senderLogin}`,
    });
    return;
  }

  // [system] plumbing (forward notices, acks) points at local-only session
  // links and carries no value for upstream readers — never mirror these.
  if (ev.comment.body.startsWith("[system]") || ev.comment.body.startsWith("[SYSTEM ")) {
    // Side-effect inside a skip path: forward-notices with an upstream marker get a rocket reaction on the upstream comment (instant GitHub ack), then the plumbing comment is dropped.
    const upstreamId = parseUpstreamAck(ev.comment.body);
    if (upstreamId && isGithubTarget(cfg) && !hasReacted(ev.comment.id)) {
      try {
        await addReaction(cfg, { owner: ev.projectOwner, repo: ev.projectName }, upstreamId, "rocket");
        markReacted(ev.comment.id, upstreamId, "rocket");
        logEvent({
          event: "issue_comment",
          action: "created",
          ework_project: projectKey,
          ework_issue: ev.issue.number,
          ework_comment: ev.comment.id,
          gitea_target: giteaTarget,
          outcome: OUTCOME_MIRRORED,
          detail: `reaction:rocket → upstream comment ${upstreamId}`,
        });
      } catch (err) {
        logEvent({
          event: "issue_comment",
          action: "created",
          ework_project: projectKey,
          ework_issue: ev.issue.number,
          ework_comment: ev.comment.id,
          gitea_target: giteaTarget,
          outcome: OUTCOME_ERROR,
          detail: `reaction failed on upstream comment ${upstreamId}: ${(err as Error).message}`,
        });
      }
    }
    logEvent({
      event: "issue_comment",
      action: "created",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      ework_comment: ev.comment.id,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_NO_REPO,
      detail: "system comment",
    });
    return;
  }
  if (isImportedComment(ev)) {
    logEvent({
      event: "issue_comment",
      action: "created",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      ework_comment: ev.comment.id,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_SELF,
      detail: "synced-from-upstream",
    });
    return;
  }

  if (getCommentMap(ev.comment.id)) {
    logEvent({
      event: "issue_comment",
      action: "created",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      ework_comment: ev.comment.id,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_DUPLICATE,
    });
    return;
  }

  const repo = await ensureGiteaRepo(cfg, ev.projectOwner, ev.projectName);
  if (!repo) {
    logEvent({
      event: "issue_comment",
      action: "created",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      ework_comment: ev.comment.id,
      gitea_target: giteaTarget,
      outcome: OUTCOME_SKIPPED_NO_REPO,
    });
    return;
  }

  let map: IssueMapRow | null =
    upstreamMap(ev, repo) ??
    getIssueMap(ev.projectOwner, ev.projectName, ev.issue.number);
  if (!map) {
    const created = await createIssue(
      cfg,
      repo,
      ev.issue.title || `(untitled ework issue #${ev.issue.number})`,
      `(retroactive mirror for comment)\n\n` +
        issueBadge(cfg, ev) +
        scrubInternalRefs(ev.issue.body ?? "", cfg) +
        mirrorFooter(ev.issue.number)
    );
    map = {
      ework_project_owner: ev.projectOwner,
      ework_project_name: ev.projectName,
      ework_issue_num: ev.issue.number,
      gitea_owner: repo.owner,
      gitea_repo: repo.repo,
      gitea_issue_num: created.number,
      ework_issue_title: ev.issue.title,
    };
    recordIssueMap({ ...map, created_at: new Date().toISOString() });
    logEvent({
      event: "issues",
      action: "opened",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      gitea_target: `${giteaTarget}#${created.number}`,
      outcome: OUTCOME_MIRRORED,
      detail: "retroactive (triggered by comment)",
    });
  }

  try {
    const agentBadge = agentLogins(cfg).includes(ev.comment.user?.login ?? "")
      ? agentBadgeText(ev.comment.model || ev.model)
      : "";
    const created = await addComment(
      cfg,
      repo,
      map.gitea_issue_num,
      agentBadge + scrubInternalRefs(ev.comment.body, cfg) + MIRROR_MARKER
    );
    recordCommentMap({
      eworkCommentId: ev.comment.id,
      eworkProjectOwner: ev.projectOwner,
      eworkProjectName: ev.projectName,
      eworkIssueNum: ev.issue.number,
      giteaOwner: repo.owner,
      giteaRepo: repo.repo,
      giteaIssueNum: map.gitea_issue_num,
      giteaCommentId: created.id,
    });
    logEvent({
      event: "issue_comment",
      action: "created",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      ework_comment: ev.comment.id,
      gitea_target: `${giteaTarget}#${map.gitea_issue_num} (comment ${created.id})`,
      outcome: OUTCOME_MIRRORED,
    });
  } catch (e) {
    logEvent({
      event: "issue_comment",
      action: "created",
      ework_project: projectKey,
      ework_issue: ev.issue.number,
      ework_comment: ev.comment.id,
      gitea_target: giteaTarget,
      outcome: OUTCOME_ERROR,
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
    throw e;
  }
}
