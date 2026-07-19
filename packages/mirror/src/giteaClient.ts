import type { Config } from "./config";

export class GiteaApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, msg?: string) {
    super(msg ?? `Gitea API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

interface GiteaIssueCreateResponse {
  id: number;
  number: number;
  state: string;
  title: string;
  body: string;
}

interface GiteaCommentCreateResponse {
  id: number;
  body: string;
  created_at: string;
}

export interface GiteaRepo {
  owner: string;
  repo: string;
}

function joinUrl(base: string, path: string): string {
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

async function giteaFetch<T>(
  cfg: Config,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = joinUrl(cfg.GITEA_URL, path);
  const headers: Record<string, string> = {
    Authorization: `token ${cfg.GITEA_TOKEN}`,
    Accept: "application/json",
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new GiteaApiError(
        res.status,
        text,
        `Gitea ${init.method ?? "GET"} ${path} → ${res.status}`
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GiteaApiError(
        res.status,
        text,
        `Gitea returned non-JSON (len=${text.length})`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function getRepo(
  cfg: Config,
  owner: string,
  repo: string
): Promise<{ id: number; name: string } | null> {
  try {
    return await giteaFetch<{ id: number; name: string }>(
      cfg,
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
  } catch (e) {
    if (e instanceof GiteaApiError && e.status === 404) return null;
    throw e;
  }
}

export async function createIssue(
  cfg: Config,
  target: GiteaRepo,
  title: string,
  body: string
): Promise<GiteaIssueCreateResponse> {
  return giteaFetch<GiteaIssueCreateResponse>(
    cfg,
    `/api/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues`,
    {
      method: "POST",
      body: JSON.stringify({ title, body }),
    }
  );
}

export async function addComment(
  cfg: Config,
  target: GiteaRepo,
  issueNumber: number,
  body: string
): Promise<GiteaCommentCreateResponse> {
  return giteaFetch<GiteaCommentCreateResponse>(
    cfg,
    `/api/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    }
  );
}

export async function patchIssueState(
  cfg: Config,
  target: GiteaRepo,
  issueNumber: number,
  state: "open" | "closed"
): Promise<GiteaIssueCreateResponse> {
  return giteaFetch<GiteaIssueCreateResponse>(
    cfg,
    `/api/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${issueNumber}`,
    {
      method: "PATCH",
      body: JSON.stringify({ state }),
    }
  );
}
