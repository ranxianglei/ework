#!/usr/bin/env bun
// Test receiver for ework webhooks. Listens on a port, prints each delivery,
// writes every received payload to a JSONL log file, and (when EWORK_TOKEN or
// EWORK_PAT is set) autonomously replies to issue_comment/created events by
// posting a marked echo comment back to the issue — closing the loop E2E.
//
// Usage:
//   bun run scripts/webhook-receiver.ts [port] [secret]
//   PORT=8099 SECRET=topsecret EWORK_PAT=xxx bun run scripts/webhook-receiver.ts
//
// Env:
//   PORT          listen port (default 8099)
//   SECRET        HMAC secret; if unset, signature verification is skipped
//   LOG_FILE      JSONL log path (default ./webhook-received.jsonl)
//   EWORK_URL     ework base URL for reply mode (default http://127.0.0.1:3002)
//   EWORK_PAT     ework personal access token (preferred; sent as Bearer)
//   EWORK_TOKEN   ework shared operator token (legacy; logs in as operator)
//   REPLY_MARKER  prefix that identifies this bot's own replies (loop guard)

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.PORT ?? process.argv[2] ?? "8099");
const SECRET = process.env.SECRET ?? process.argv[3] ?? "";
const LOG_FILE = resolve(process.env.LOG_FILE ?? "./webhook-received.jsonl");
const EWORK_URL = (process.env.EWORK_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
const EWORK_PAT = process.env.EWORK_PAT ?? "";
const EWORK_TOKEN = process.env.EWORK_TOKEN ?? "";
const REPLY_MARKER = process.env.REPLY_MARKER ?? "[bot] echo:";

mkdirSync(resolve(LOG_FILE, ".."), { recursive: true });

let replyCookie: string | null = null;

async function loginReply(): Promise<string> {
  if (!EWORK_TOKEN) throw new Error("reply-login requested but EWORK_TOKEN is not set");
  const r = await fetch(`${EWORK_URL}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: EWORK_TOKEN }).toString(),
    redirect: "manual",
  });
  const setCookie = r.headers.get("set-cookie");
  if (!setCookie) throw new Error(`reply-login: no set-cookie, status=${r.status}`);
  const match = setCookie.match(/(ework_auth=[^;]+)/);
  if (!match) throw new Error("reply-login: no ework_auth in set-cookie");
  replyCookie = match[1];
  return replyCookie;
}

async function replyToIssue(repo: string, issueNumber: number, body: string): Promise<void> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (EWORK_PAT) {
      headers.authorization = `Bearer ${EWORK_PAT}`;
    } else {
      if (!replyCookie) await loginReply();
      headers.cookie = replyCookie ?? "";
    }
    const doFetch = () => fetch(`${EWORK_URL}/api/${repo}/issues/${issueNumber}/comment`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    let res = await doFetch();
    if (!EWORK_PAT && (res.status === 401 || res.status === 302)) {
      await loginReply();
      headers.cookie = replyCookie ?? "";
      res = await doFetch();
    }
    console.log(`[reply] ${repo}#${issueNumber} status=${res.status} bodyLen=${body.length} auth=${EWORK_PAT ? "PAT" : "cookie"}`);
  } catch (e) {
    console.log(`[reply-error] ${repo}#${issueNumber} ${e}`);
  }
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function verifySig(body: string, header: string | null): boolean {
  if (!SECRET) return true;
  if (!header) return false;
  const expected = sign(body);
  if (expected.length !== header.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("ework webhook receiver ready\n", { headers: { "Content-Type": "text/plain" } });
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed\n", { status: 405 });
    }

    const rawBody = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });

    const delivery = headers["x-gitea-delivery"] ?? headers["x-github-delivery"] ?? "(none)";
    const event = headers["x-gitea-event"] ?? headers["x-github-event"] ?? "(none)";
    const sig = headers["x-gitea-signature"] ?? headers["x-gogs-signature"] ?? null;
    const ghSig = headers["x-github-signature-256"] ?? null;

    const valid = verifySig(rawBody, sig);
    const ghValid = !SECRET || (ghSig ? ghSig === `sha256=${sign(rawBody)}` : false);

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // ignore — non-JSON body, leave parsed null
    }

    const summary = {
      ts: new Date().toISOString(),
      delivery,
      event,
      sig_present: !!sig,
      sig_valid: valid,
      gh_sig_present: !!ghSig,
      gh_sig_valid: ghValid,
      content_type: headers["content-type"] ?? null,
      user_agent: headers["user-agent"] ?? null,
      path: url.pathname,
      body_len: rawBody.length,
      body: parsed,
      raw: rawBody,
    };

    appendFileSync(LOG_FILE, JSON.stringify(summary) + "\n");

    const status = valid ? 200 : 401;
    const tag = valid ? "OK" : "BAD-SIG";
    const preview = typeof parsed === "object" && parsed && "action" in (parsed as Record<string, unknown>)
      ? ` action=${(parsed as { action: string }).action}`
      : "";
    console.log(
      `[${summary.ts}] ${event} delivery=${delivery.slice(0, 8)} ${tag}${preview} len=${rawBody.length} sig=${sig ? sig.slice(0, 10) + "…" : "-"} gh_sig=${ghValid ? "ok" : (ghSig ? "BAD" : "-")}`
    );

    if (!valid) {
      return new Response("invalid signature\n", { status: 401 });
    }

    // Echo mode: return the exact raw body we received, preserving content-type.
    // Lets callers (curl / ework debug) see round-trip what ework is sending.
    //
    // Fire-and-forget autonomous reply for issue_comment/created events when
    // EWORK_TOKEN is configured. Marker prefix prevents infinite self-reply
    // loops (bot replies to its own replies).
    if ((EWORK_PAT || EWORK_TOKEN) && event === "issue_comment") {
      const p = parsed as {
        action?: string;
        issue?: { number?: number };
        repository?: { full_name?: string };
        comment?: { body?: string };
      } | null;
      const orig = p?.comment?.body ?? "";
      if (p?.action === "created" && p.issue?.number && p.repository?.full_name && orig) {
        if (orig.startsWith(REPLY_MARKER)) {
          console.log(`[reply-skip] body starts with marker — own reply, no loop`);
        } else {
          void replyToIssue(p.repository.full_name, p.issue.number, `${REPLY_MARKER}\n\n${orig}`);
        }
      }
    }

    return new Response(rawBody, {
      status: 200,
      headers: { "Content-Type": headers["content-type"] ?? "application/json" },
    });
  },
});

console.log(`ework webhook receiver listening on http://localhost:${server.port}`);
console.log(`  secret: ${SECRET ? SECRET.length + " chars" : "(none — no signature verification)"}`);
console.log(`  log:    ${LOG_FILE}`);
console.log(`\nTo configure against ework, add a webhook at:`);
console.log(`  http://localhost:${server.port}/hook`);
console.log(`\nCtrl-C to stop.`);
