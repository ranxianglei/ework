import type { Config } from "./config";

export class GiteaClient {
  private url: string;
  private token: string;
  private botToken: string;

  constructor(cfg: Config["gitea"], botToken: string) {
    this.url = cfg.url.replace(/\/$/, "");
    this.token = cfg.token;
    this.botToken = botToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    useBotToken = false
  ): Promise<T> {
    const token = useBotToken ? this.botToken : this.token;
    const res = await fetch(`${this.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gitea API ${method} ${path} → ${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getIssue(owner: string, repo: string, number: number) {
    return this.request<{
      id: number;
      number: number;
      title: string;
      body: string;
      state: string;
      html_url: string;
      user: { login: string };
    }>("GET", `/repos/${owner}/${repo}/issues/${number}`);
  }

  async createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ) {
    return this.request<{
      id: number;
      body: string;
      html_url: string;
    }>("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      body,
    }, true);
  }

  async updateIssueStatus(
    owner: string,
    repo: string,
    issueNumber: number,
    status: string,
    detail?: string
  ): Promise<void> {
    try {
      await this.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/status`, {
        status,
        detail,
      }, true);
    } catch (e) {
      console.warn("[gitea] updateIssueStatus failed:", (e as Error).message);
    }
  }

  async editComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ) {
    return this.request<{
      id: number;
      body: string;
    }>("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      body,
    }, true);
  }

  async deleteComment(owner: string, repo: string, commentId: number) {
    return this.request<void>(
      "DELETE", `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      undefined, true
    );
  }

  async listComments(owner: string, repo: string, issueNumber: number) {
    return this.request<
      Array<{ id: number; body: string; created_at: string; user: { login: string } }>
    >("GET", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
  }

  async closeIssue(owner: string, repo: string, issueNumber: number) {
    return this.request<{
      number: number;
      state: string;
    }>("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, {
      state: "closed",
    });
  }

  async addReaction(owner: string, repo: string, issueNumber: number, content: string) {
    return this.request(
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/reactions`,
      { content },
      true
    );
  }

  async removeReaction(owner: string, repo: string, issueNumber: number, content: string) {
    return this.request(
      "DELETE",
      `/repos/${owner}/${repo}/issues/${issueNumber}/reactions`,
      { content },
      true
    );
  }

  async addCommentReaction(owner: string, repo: string, commentId: number, content: string) {
    return this.request(
      "POST",
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      { content },
      true
    );
  }

  async removeCommentReaction(owner: string, repo: string, commentId: number, content: string) {
    return this.request(
      "DELETE",
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      { content },
      true
    );
  }
}
