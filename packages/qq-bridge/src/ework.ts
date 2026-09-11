export interface EworkClient {
  createIssue(owner: string, repo: string, title: string, body: string): Promise<number>;
  addComment(owner: string, repo: string, number: number, body: string): Promise<void>;
}

export function createEworkClient(baseUrl: string, token: string): EworkClient {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  async function request(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${root}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ework ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  }
  return {
    async createIssue(owner, repo, title, body) {
      const res = await request(`/repos/${owner}/${repo}/issues`, { title, body });
      const data = (await res.json()) as { number?: unknown };
      const n = Number(data.number);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`ework createIssue returned no number: ${JSON.stringify(data).slice(0, 200)}`);
      return n;
    },
    async addComment(owner, repo, number, body) {
      await request(`/repos/${owner}/${repo}/issues/${number}/comments`, { body });
    },
  };
}
