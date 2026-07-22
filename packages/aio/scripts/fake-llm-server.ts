#!/usr/bin/env bun
// Fake OpenAI-compatible LLM server for E2E tests.
//
// Listens on 127.0.0.1:PORT and responds to /v1/chat/completions with a
// deterministic, context-aware canned reply. Used by the docker E2E test
// to drive real `opencode run` against a stub LLM — opencode can't tell
// the difference, writes a real session to opencode.db, and awork-web can
// then render that session via its normal /sessions/:id route.
//
// Why not just stub the opencode binary? Because awork-web reads opencode.db
// directly (src/opencode.ts:98-139 listSessions) and calls `opencode export`
// for transcripts — stubbing the binary means re-implementing the SQLite
// schema, which would silently drift from real opencode. Talking to a fake
// LLM exercises every piece except the network call to a real model.
//
// Usage:
//   PORT=8400 bun run scripts/fake-llm-server.ts
//   # or just: bun run scripts/fake-llm-server.ts  (defaults to 8400)

const PORT = parseInt(process.env.PORT ?? "8400", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req) {
    const url = new URL(req.url);
    log(`${req.method} ${url.pathname}`);

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json({
        object: "list",
        data: [
          {
            id: "fake-model",
            object: "model",
            created: 1_700_000_000_000,
            owned_by: "e2e-test",
          },
        ],
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChatCompletion(req);
    }

    return json({ error: `not found: ${req.method} ${url.pathname}` }, 404);
  },
});

function log(msg: string): void {
  process.stderr.write(`[fake-llm] ${new Date().toISOString()} ${msg}\n`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

async function handleChatCompletion(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch (err) {
    return json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
  }

  // Log the full request so we can see what opencode/@ai-sdk is asking for
  // (stream vs non-stream, tool definitions, system prompt, etc).
  log(`  body: stream=${body?.stream} model=${body?.model} msgs=${body?.messages?.length} tools=${body?.tools?.length ?? 0}`);

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const lastMsg = messages[messages.length - 1];
  const lastRole = lastMsg?.role;
  const userMsgs = messages.filter((m: any) => m?.role === "user");
  const lastUser = userMsgs[userMsgs.length - 1];
  const userText = typeof lastUser?.content === "string"
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.map((p: any) => p?.text ?? "").join(" ")
      : "";

  const hasReplyTool = tools.some((t: any) => t?.function?.name === "reply");

  // Tool-call path: when `reply` is registered and the last message is the
  // user's initial prompt (not a tool_result), emit a tool_use so opencode
  // actually invokes the reply tool → ework-web posts a [bot] comment on the
  // issue. Without this the daemon only posts its [system] "picked up"
  // notification and the LLM-driven auto-reply loop never fires.
  //
  // After opencode executes the tool it makes a follow-up call with
  // role=tool in the messages — at that point we drop back to text.
  if (hasReplyTool && lastRole === "user") {
    const ref = parseIssueRef(userText);
    if (ref) {
      log(`  emitting reply tool_use → ${ref.owner}/${ref.repo}#${ref.number}`);
      const toolReplyBody =
        `[bot] E2E fake-LLM auto-reply.\n\n` +
        `Picked up ${ref.owner}/${ref.repo}#${ref.number}. ` +
        `This is a stub reply emitted by scripts/fake-llm-server.ts to exercise ` +
        `the opencode-ework \`reply\` tool end-to-end. The real value of this ` +
        `test is that opencode received a tool_use, executed the reply tool, ` +
        `and ework-web posted this comment as ${process.env.BOT_USERNAME ?? "bot"}.`;
      return toolCallResponse(body?.model ?? "fake-model", "reply", {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        body: toolReplyBody,
      }, body?.stream === true);
    }
  }

  // Deterministic, context-aware reply: echo a snippet of the user's last
  // message so the session transcript has traceable content (not just a
  // fixed string). Truncated so the reply stays readable in the UI.
  const snippet = userText.slice(0, 120).replace(/\s+/g, " ").trim();
  const reply =
    `E2E fake-LLM reply.\n\n` +
    `You said: "${snippet}${userText.length > 120 ? "…" : ""}"\n\n` +
    `This is a stub response from scripts/fake-llm-server.ts. ` +
    `The real value of this test is that opencode wrote a real session row ` +
    `to opencode.db and awork-web can render it end-to-end.`;

  const promptTokens = roughTokens(JSON.stringify(messages));
  const completionTokens = roughTokens(reply);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };

  // opencode (@ai-sdk/openai-compatible) defaults to stream=true. Returning
  // a non-streaming JSON response silently produces a 0-token session row
  // with no assistant text — the request completes but the transcript is
  // empty. Honor the stream flag and emit SSE chunks.
  if (body?.stream === true) {
    return streamResponse(body?.model ?? "fake-model", reply, usage);
  }

  // Non-streaming path (used by curl sanity checks in tests).
  return json({
    id: `chatcmpl-fake-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? "fake-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    usage,
  });
}

// Parse an issue ref of the form `<owner>/<repo>#<n>` out of arbitrary text
// (typically the user prompt built by ework-daemon's buildInitialPrompt,
// which includes "(gitea:owner/repo#N)"). Returns null if no match.
function parseIssueRef(text: string): { owner: string; repo: string; number: number } | null {
  const m = text.match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)/);
  if (!m) return null;
  const [, owner, repo, num] = m;
  const number = parseInt(num, 10);
  if (!Number.isFinite(number)) return null;
  return { owner, repo, number };
}

// Emit a tool_use response (OpenAI function-calling format). Supports both
// streaming and non-streaming because opencode defaults to stream=true but
// curl smoke tests use non-streaming.
function toolCallResponse(model: string, toolName: string, args: Record<string, unknown>, stream: boolean): Response {
  const id = `chatcmpl-fake-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const argsJson = JSON.stringify(args);
  const usage = {
    prompt_tokens: roughTokens(argsJson),
    completion_tokens: roughTokens(argsJson),
    total_tokens: roughTokens(argsJson) * 2,
  };

  if (!stream) {
    return json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: callId,
                type: "function",
                function: { name: toolName, arguments: argsJson },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    });
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      // Initial chunk: declare the tool_call with name + empty arguments.
      controller.enqueue(
        encoder.encode(
          sseLine({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  index: 0,
                  id: callId,
                  type: "function",
                  function: { name: toolName, arguments: "" },
                }],
              },
              finish_reason: null,
            }],
          }),
        ),
      );
      // Arguments chunk: full JSON in one shot (splitting is optional).
      controller.enqueue(
        encoder.encode(
          sseLine({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: argsJson } }],
              },
              finish_reason: null,
            }],
          }),
        ),
      );
      // Final chunk: finish_reason + usage.
      controller.enqueue(
        encoder.encode(
          sseLine({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage,
          }),
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

function streamResponse(model: string, reply: string, usage: any): Response {
  const id = `chatcmpl-fake-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Split into ~10 chunks so the streaming code path actually streams
  // (single-chunk streams work but look unrealistic in logs).
  const chunks: string[] = [];
  const words = reply.split(/(\s+)/);
  const perChunk = Math.max(1, Math.ceil(words.length / 10));
  for (let i = 0; i < words.length; i += perChunk) {
    chunks.push(words.slice(i, i + perChunk).join(""));
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      // First chunk: role + opening content.
      controller.enqueue(
        encoder.encode(
          sseLine({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant", content: chunks[0] ?? "" }, finish_reason: null }],
          }),
        ),
      );
      // Subsequent chunks: content deltas only.
      for (let i = 1; i < chunks.length; i++) {
        controller.enqueue(
          encoder.encode(
            sseLine({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
            }),
          ),
        );
      }
      // Final chunk: empty delta + finish_reason + usage (usage must be on
      // the final chunk when stream_options.include_usage is set; opencode
      // sets it so the session row gets non-zero token counts).
      controller.enqueue(
        encoder.encode(
          sseLine({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          }),
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

function sseLine(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function roughTokens(text: string): number {
  // Crude 4-chars-per-token heuristic. Token counts only need to be >0 for
  // awork-web's heat bar (which divides by max-peak-token across the session).
  // Real tokenizer isn't needed for test data.
  return Math.max(1, Math.ceil(text.length / 4));
}

process.stderr.write(
  `[fake-llm] listening on http://${HOST}:${PORT}\n` +
    `[fake-llm] POST /v1/chat/completions  -> canned OpenAI response\n` +
    `[fake-llm] GET  /v1/models           -> { fake-model }\n`,
);

// Keep stderr unbuffered so logs show up immediately in docker output.
process.stderr.write(`[fake-llm] ready (pid ${process.pid})\n`);
