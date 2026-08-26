import type { Config } from "./config";
import {
  getIssueMap,
  recordIssueMap,
  getCommentMap,
  recordCommentMap,
  logEvent,
  type IssueMapRow,
} from "./db";
import {
  createIssue,
  addComment,
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
// upstream-sync marker. The issue-level upstream number must NOT suppress
// comments — AI replies and local discussion on imported issues must mirror.
// It only stops mirroring an imported issue's "opened" (no twin creation).
export function isImportedComment(ev: { comment?: { body?: string } }): boolean {
  return (ev.comment?.body ?? "").includes(UPSTREAM_SYNC_MARKER);
}

export function isImportedIssue<T extends { issue: { upstream_issue_number?: number | null } }>(ev: T): boolean {
  return ev.issue.upstream_issue_number != null;
}

function upstreamMap(ev: { projectOwner: string; projectName: string; issue: { number: number; upstream_issue_number?: number | null; title?: string | null } }, repo: { owner: string; repo: string }): IssueMapRow | null {
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

function mirrorFooter(origin: string, issueNum: number): string {
  return `\n\n---\n_Mirrored from ework [${origin}/issues/${issueNum}](${origin}/issues/${issueNum})_`;
}

// Outbound hygiene: nothing that identifies this deployment's network may
// reach the public upstream — internal hostnames and RFC1918 addresses are
// redacted from every mirrored body before it leaves the box.
const INTERNAL_PATTERNS: Array<[RegExp, string]> = [
  [/m1\.redoxos\.org/g, "[internal-host]"],
  [/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\b/g, "[internal-ip]"],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "[internal-ip]"],
  [/\bework-sandbox\b/g, "[internal-host]"],
];

export function scrubInternalRefs(text: string): string {
  return INTERNAL_PATTERNS.reduce((acc, [re, sub]) => acc.replace(re, sub), text);
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
        scrubInternalRefs(ev.issue.body ?? "") + mirrorFooter(eworkOrigin, ev.issue.number)
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

    const map = getIssueMap(ev.projectOwner, ev.projectName, ev.issue.number);
    if (!map) {
      const created = await createIssue(
        cfg,
        repo,
        ev.issue.title,
        `(retroactive mirror for state=${ev.action})\n\n` +
          scrubInternalRefs(ev.issue.body ?? "") +
          mirrorFooter(eworkOrigin, ev.issue.number)
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
        scrubInternalRefs(ev.issue.body ?? "") +
        mirrorFooter(eworkOrigin, ev.issue.number)
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
    const created = await addComment(
      cfg,
      repo,
      map.gitea_issue_num,
      scrubInternalRefs(ev.comment.body) + MIRROR_MARKER
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
