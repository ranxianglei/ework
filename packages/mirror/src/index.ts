import { createHmac, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config";
import { initDB } from "./db";
import { parseEvent, ParseError } from "./ework";
import { handleIssueEvent, handleCommentEvent } from "./mirror";

const cfg = loadConfig();
initDB(cfg.DB_PATH);

function log(...args: unknown[]): void {
  if (cfg.VERBOSE) console.log("[ework-mirror]", ...args);
}

function verifySignature(secret: string, rawBody: string, sigHex: string): boolean {
  if (!secret) return true;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (sigHex.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sigHex), Buffer.from(expected));
  } catch {
    return false;
  }
}

const server = Bun.serve({
  port: cfg.PORT,
  hostname: cfg.HOST,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok\n", { headers: { "content-type": "text/plain" } });
    }

    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname !== "/ingest/ework") {
      return new Response("not found", { status: 404 });
    }

    const eventHeader = req.headers.get("x-gitea-event") ??
      req.headers.get("x-github-event") ??
      "";
    const sig =
      req.headers.get("x-gitea-signature") ??
      req.headers.get("x-gogs-signature") ??
      req.headers.get("x-hub-signature-256")?.replace(/^sha256=/, "") ??
      "";

    const rawBody = await req.text();

    if (!verifySignature(cfg.EWORK_WEBHOOK_SECRET, rawBody, sig)) {
      console.warn(
        `[ework-mirror] rejecting webhook: bad signature (event=${eventHeader})`
      );
      return new Response("bad signature", { status: 401 });
    }

    let parsed;
    try {
      parsed = parseEvent(rawBody, eventHeader);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ework-mirror] parse failed: ${msg}`);
      return new Response(`bad payload: ${msg}`, { status: 400 });
    }

    const eworkOrigin = req.headers.get("origin") ??
      `http://${req.headers.get("host") ?? "localhost"}`;

    log(
      "event",
      parsed.kind,
      "action" in parsed ? parsed.action : "",
      `${parsed.projectOwner}/${parsed.projectName}#${parsed.issue.number}`,
      "sender=" + parsed.senderLogin
    );

    try {
      if (parsed.kind === "issues") {
        await handleIssueEvent(cfg, eworkOrigin, parsed);
      } else {
        await handleCommentEvent(cfg, eworkOrigin, parsed);
      }
      return new Response("accepted", { status: 202 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ework-mirror] handler error: ${msg}`);
      return new Response(`handler error: ${msg}`, { status: 502 });
    }
  },
});

console.log(
  `[ework-mirror] listening on http://${server.hostname}:${server.port}/ingest/ework`
);
console.log(`[ework-mirror] db at ${cfg.DB_PATH}`);
console.log(`[ework-mirror] gitea target: ${cfg.GITEA_URL} (as ${cfg.GITEA_ACT_AS})`);
if (!cfg.EWORK_WEBHOOK_SECRET) {
  console.warn("[ework-mirror] WARNING: EWORK_WEBHOOK_SECRET empty — signature not verified");
}
