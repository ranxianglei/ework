import { z } from "zod";
import { loadConfig } from "./config";
import { ConversationStore } from "./store";
import { buildChatMessages, windowFrom, DEFAULT_SYSTEM_PROMPT, capContent } from "./context";
import { chatComplete } from "./llm";

const cfg = loadConfig();
const store = new ConversationStore(cfg.DATA_DIR);
const queues = new Map<string, Promise<unknown>>();

const chatSchema = z.object({
  conversation: z.string().min(1).max(128),
  message: z.string().min(1).max(32000),
  user: z.string().max(64).optional(),
  system: z.string().max(4000).optional(),
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function authed(req: Request): boolean {
  if (!cfg.TOKEN) return true;
  const h = req.headers.get("authorization") ?? "";
  return h === `Bearer ${cfg.TOKEN}`;
}

// One queued unit = full turn: user append → LLM → assistant append.
// The assistant append MUST stay inside the queue; otherwise the next queued
// turn could build its context before this reply reached the disk log.
async function runChat(conversation: string, message: string, user: string | undefined, system: string | undefined): Promise<string> {
  store.append(conversation, { role: "user", name: user ?? "", content: message });
  const systemPrompt = system ?? DEFAULT_SYSTEM_PROMPT;
  const history = store.history(conversation);
  const from = windowFrom(history, store.sendFrom(conversation), cfg.MAX_HISTORY, cfg.MAX_CONTEXT_TOKENS, systemPrompt);
  if (from !== store.sendFrom(conversation)) store.setSendFrom(conversation, from);
  const windowed = history.slice(from);
  const question = windowed[windowed.length - 1] ?? { role: "user" as const, name: user ?? "", content: message };
  const prior = windowed.slice(0, -1);
  const messages = buildChatMessages(prior, question, systemPrompt);
  const reply = await chatComplete(cfg.UPSTREAM, cfg.API_KEY, cfg.MODEL, messages, cfg.TIMEOUT_MS, cfg.NO_THINK);
  store.append(conversation, { role: "assistant", name: "", content: reply });
  return reply;
}

function enqueue(conversation: string, task: () => Promise<string>): Promise<string> {
  const prev = queues.get(conversation) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(conversation, next.catch(() => {}));
  return next;
}

const server = Bun.serve({
  hostname: cfg.HOST,
  port: cfg.PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return json(200, { ok: true });

    if (!authed(req)) return json(401, { error: "unauthorized" });

    if (req.method === "POST" && url.pathname === "/v1/chat") {
      if (!cfg.UPSTREAM || !cfg.MODEL) return json(503, { error: "chat not configured (CHAT_UPSTREAM / CHAT_MODEL)" });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const parsed = chatSchema.safeParse(body);
      if (!parsed.success) return json(400, { error: parsed.error.issues[0]?.message ?? "invalid body" });
      const { conversation, message, user, system } = parsed.data;
      try {
        const reply = await enqueue(conversation, () => runChat(conversation, capContent(message), user, system));
        return json(200, { conversation, reply });
      } catch (err) {
        return json(502, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const convMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
    if (convMatch) {
      const id = decodeURIComponent(convMatch[1] ?? "");
      if (req.method === "GET") {
        return json(200, { conversation: id, turns: store.history(id) });
      }
      if (req.method === "DELETE") {
        return json(store.delete(id) ? 200 : 404, { deleted: id });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/conversations") {
      return json(200, { conversations: store.list() });
    }

    return json(404, { error: "not found" });
  },
});

console.log(`[ework-chat] listening on ${cfg.HOST}:${cfg.PORT} (data: ${cfg.DATA_DIR}, upstream: ${cfg.UPSTREAM || "<unset>"})`);
console.log(`[ework-chat] POST /v1/chat {conversation, message, user?, system?} → {reply}`);

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
