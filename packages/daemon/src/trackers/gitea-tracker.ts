import { createHmac, timingSafeEqual } from "crypto";
import type { GiteaClient } from "../gitea";
import type {
  IssueTracker,
  TrackerRef,
  TrackerEvent,
  TrackerComment,
  TrackerInstructions,
} from "./types";

export class GiteaTracker implements IssueTracker {
  readonly type = "gitea";

  private client: GiteaClient;
  private url: string;
  private webhookSecret: string;
  private botUsername: string;

  constructor(client: GiteaClient, url: string, webhookSecret: string, botUsername: string) {
    this.client = client;
    this.url = url.replace(/\/$/, "");
    this.webhookSecret = webhookSecret;
    this.botUsername = botUsername;
  }

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }

  private owner(ref: TrackerRef) { return ref.scope["owner"]!; }
  private repo(ref: TrackerRef) { return ref.scope["repo"]!; }

  createComment(ref: TrackerRef, body: string) {
    return this.client.createComment(
      this.owner(ref), this.repo(ref), Number(ref.issueId), body
    ).then(r => ({ id: String(r.id) }));
  }

  async editComment(ref: TrackerRef, commentId: string, body: string) {
    await this.client.editComment(
      this.owner(ref), this.repo(ref), Number(commentId), body
    );
  }

  async deleteComment(ref: TrackerRef, commentId: string) {
    await this.client.deleteComment(
      this.owner(ref), this.repo(ref), Number(commentId)
    );
  }

  listComments(ref: TrackerRef): Promise<TrackerComment[]> {
    return this.client.listComments(
      this.owner(ref), this.repo(ref), Number(ref.issueId)
    ).then(comments => comments.map(c => ({
      id: String(c.id),
      body: c.body,
      author: c.user.login,
      createdAt: c.created_at,
    })));
  }

  async closeIssue(ref: TrackerRef) {
    await this.client.closeIssue(
      this.owner(ref), this.repo(ref), Number(ref.issueId)
    );
  }

  async updateStatus(ref: TrackerRef, status: string, detail?: string) {
    await this.client.updateIssueStatus(
      this.owner(ref), this.repo(ref), Number(ref.issueId), status, detail
    );
  }

  async setCommentModel(ref: TrackerRef, commentId: string, model: string) {
    await this.client.setCommentModel(
      this.owner(ref), this.repo(ref), Number(commentId), model
    );
  }

  async setReaction(ref: TrackerRef, commentId: string, content: string, remove = false) {
    if (remove) {
      await this.client.removeCommentReaction(
        this.owner(ref), this.repo(ref), Number(commentId), content
      );
    } else {
      await this.client.addCommentReaction(
        this.owner(ref), this.repo(ref), Number(commentId), content
      );
    }
  }

  getTrackerInstructions(ref: TrackerRef): TrackerInstructions {
    const owner = this.owner(ref);
    const repo = this.repo(ref);
    const num = ref.issueId;
    return {
      clone: `git clone ${this.url}/${owner}/${repo}.git .`,
      issueRef: `${owner}/${repo}#${num}`,
      closeIssue: `tea issues close ${num} --repo ${owner}/${repo}`,
    };
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string | null>): boolean {
    const signature = headers["x-gitea-signature"];
    if (!this.webhookSecret) return true;
    if (!signature) return false;

    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  parseWebhookEvent(rawBody: string): TrackerEvent | null {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const action = payload.action;
    const issue = payload.issue as Record<string, unknown> | undefined;
    const comment = payload.comment as Record<string, unknown> | undefined;
    const repository = payload.repository as Record<string, unknown> | undefined;
    if (typeof action !== "string") return null;
    if (!repository || typeof repository !== "object") return null;
    if (!issue || typeof issue !== "object") return null;
    if (issue.number == null) return null;

    const repoOwner = (repository.owner as Record<string, string>)?.login;
    const repoName = repository.name as string;
    if (!repoOwner || !repoName) return null;

    const cloneUrl = typeof repository.clone_url === "string" ? repository.clone_url : undefined;
    const sender = (payload.sender as Record<string, string>)?.login;

    // ework-web extension (non-Gitea field, ignored by strict Gitea consumers).
    // Empty/missing = no model override; engine omits --model.
    const modelRaw = repository.ework_model;
    const model = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : undefined;
    const runtimeRaw = repository.ework_runtime;
    const runtime = runtimeRaw === "pi" || runtimeRaw === "opencode" ? runtimeRaw : undefined;

    const ref: TrackerRef = {
      trackerType: "gitea",
      scope: { owner: repoOwner, repo: repoName },
      issueId: String(issue.number),
    };

    const issueUser = issue.user as Record<string, string>;
    const aiStatus = typeof issue.ai_status === "string" ? issue.ai_status : "";
    const dispatchOff = payload.dispatch_off === true;

    if (action === "opened" || action === "reopened") {
      return {
        type: "issue_opened",
        ref,
        dispatch_off: dispatchOff,
        issue: {
          title: issue.title as string,
          body: (issue.body as string) ?? "",
          state: (issue.state as string) ?? "open",
          author: issueUser?.login ?? "",
          ai_status: aiStatus,
        },
        model,
        runtime,
        cloneUrl,
        sender,
      };
    }

    if (action === "created" && comment) {
      const commentUser = comment.user as Record<string, string>;
      return {
        type: "comment_created",
        ref,
        issue: {
          title: issue.title as string,
          body: (issue.body as string) ?? "",
          state: (issue.state as string) ?? "open",
          author: issueUser?.login ?? "",
          ai_status: aiStatus,
        },
        comment: {
          id: String(comment.id),
          body: comment.body as string,
          author: commentUser?.login ?? "",
          authorKind: (comment as Record<string, unknown>).author_kind as string | undefined,
        },
        model,
        runtime,
        cloneUrl,
        sender,
      };
    }

    if (action === "closed") {
      return {
        type: "issue_closed",
        ref,
        issue: {
          title: issue.title as string,
          body: (issue.body as string) ?? "",
          state: "closed",
          author: issueUser?.login ?? "",
          ai_status: aiStatus,
        },
        model,
        runtime,
        cloneUrl,
        sender,
      };
    }

    if (action === "status_changed") {
      const status = payload.status as { from?: string; to?: string; detail?: string } | undefined;
      return {
        type: "status_changed" as const,
        ref,
        issue: {
          title: issue.title as string,
          body: (issue.body as string) ?? "",
          state: (issue.state as string) ?? "open",
          author: issueUser?.login ?? "",
          ai_status: aiStatus,
        },
        status: {
          from: status?.from ?? "",
          to: status?.to ?? "",
          detail: status?.detail,
        },
        sender,
      };
    }

    return null;
  }

  isBotUser(userIdentifier: string): boolean {
    return userIdentifier === this.botUsername;
  }
}
