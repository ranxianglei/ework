#!/usr/bin/env bun
const PORT = Number(process.env.FAKE_LLM_PORT ?? 8401);
const HOST = process.env.FAKE_LLM_HOST ?? "127.0.0.1";

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [{
          id: "fake/fake-model",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "e2e",
        }],
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return handleChatCompletion(req);
    }

    return new Response("Not found", { status: 404 });
  },
});

async function handleChatCompletion(req: Request): Promise<Response> {
  const body = await req.json() as {
    model?: string;
    messages?: Array<{ role: string; content: unknown }>;
    tools?: Array<unknown>;
    stream?: boolean;
  };

  const model = body.model ?? "fake/fake-model";
  const isStream = body.stream ?? false;
  const hasTools = (body.tools?.length ?? 0) > 0;

  if (!hasTools) {
    return textResponse(model, "Acknowledged.", isStream);
  }

  const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const replyBody = JSON.stringify({ body: "[bot] Processed by fake LLM" });

  if (!isStream) {
    return Response.json({
      id: `chatcmpl-fake-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: callId,
            type: "function",
            function: { name: "reply", arguments: replyBody },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  const encoder = new TextEncoder();
  const id = `chatcmpl-fake-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0, id: callId, type: "function",
              function: { name: "reply", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: replyBody } }] },
          finish_reason: null,
        }],
      })}\n\n`));

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function textResponse(model: string, text: string, isStream: boolean): Response {
  if (!isStream) {
    return Response.json({
      id: `chatcmpl-fake-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
  }
  return new Response("data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

process.stderr.write(`[fake-llm] listening on http://${HOST}:${PORT}\n`);
