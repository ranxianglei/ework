import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookComment {
  commentId: number;
  owner: string;
  repo: string;
  number: number;
  author: string;
  body: string;
}

interface IngestDeps {
  secret: string;
  bridgeLogin: string;
  agentLogins: Set<string>;
  scrub: (text: string) => string;
  projectOf(owner: string, repo: string): number | null;
  commentForwarded(commentId: number): boolean;
  send(groupId: number, text: string): Promise<void>;
}

// Looping agent sessions can emit a reply every few seconds; cap forwards
// per issue so a runaway session cannot flood the group.
const FORWARD_WINDOW_MS = 60_000;
const FORWARD_MAX_PER_WINDOW = 5;
const forwardTimestamps = new Map<string, number[]>();

function forwardAllowed(key: string, now = Date.now()): boolean {
  const list = (forwardTimestamps.get(key) ?? []).filter((t) => now - t < FORWARD_WINDOW_MS);
  if (list.length >= FORWARD_MAX_PER_WINDOW) {
    forwardTimestamps.set(key, list);
    return false;
  }
  list.push(now);
  forwardTimestamps.set(key, list);
  return true;
}

export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!secret) return true;
  if (!header) return false;
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  // Gitea sends bare hex in X-Gitea-Signature; GitHub-style sends "sha256=<hex>".
  const candidates = [hex, `sha256=${hex}`];
  return candidates.some((expected) => {
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export function createIngest(deps: IngestDeps) {
  return async function ingest(req: Request): Promise<Response> {
    const event = req.headers.get("x-gitea-event") ?? "";
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const raw = await req.text();
    if (!verifySignature(deps.secret, raw, req.headers.get("x-gitea-signature"))) {
      console.warn(`[qq-bridge] rejecting webhook: bad signature (event=${event})`);
      return new Response("bad signature", { status: 401 });
    }
    if (event !== "issue_comment") return new Response("ignored", { status: 200 });

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const action = String(parsed.action ?? "");
    if (action !== "created") return new Response("ignored", { status: 200 });

    const repo = (parsed.repository ?? {}) as Record<string, unknown>;
    const owner = ((repo.owner ?? {}) as Record<string, unknown>).login;
    const issue = (parsed.issue ?? {}) as Record<string, unknown>;
    const comment = (parsed.comment ?? {}) as Record<string, unknown>;
    if (typeof owner !== "string" || typeof repo.name !== "string") return new Response("ignored", { status: 200 });

    const author = String(((comment.user ?? {}) as Record<string, unknown>).login ?? "");
    const body = String(comment.body ?? "");
    const number = Number(issue.number);
    const commentId = Number(comment.id);

    // Echo guard: our own posts and plumbing notices must never loop back.
    if (author === deps.bridgeLogin) return new Response("skipped:self", { status: 200 });
    if (body.startsWith("[system]") || body.startsWith("[SYSTEM ")) return new Response("skipped:system", { status: 200 });
    if (!deps.agentLogins.has(author)) return new Response("skipped:non-agent", { status: 200 });

    const groupId = deps.projectOf(owner, String(repo.name));
    if (groupId === null) return new Response("skipped:unmapped", { status: 200 });
    if (!Number.isInteger(commentId) || deps.commentForwarded(commentId)) {
      return new Response("skipped:dup", { status: 200 });
    }

    if (!forwardAllowed(`${owner}/${String(repo.name)}#${number}`)) {
      console.warn(`[qq-bridge] forward rate-limited for ${owner}/${String(repo.name)}#${number}`);
      return new Response("rate-limited", { status: 200 });
    }
    const text = deps.scrub(`[#${number}] ${body}`);
    try {
      await deps.send(groupId, text);
    } catch (err) {
      console.error(`[qq-bridge] send_group_msg failed: ${err instanceof Error ? err.message : err}`);
      return new Response("send failed", { status: 502 });
    }
    return new Response("forwarded", { status: 200 });
  };
}
