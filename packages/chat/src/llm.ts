import { stripThink, type WireMessage } from "./context";

type ToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };

type WireTurn =
  | ({ role: "system" | "user" | "assistant"; name?: string; content: string } & Record<string, unknown>)
  | ({ role: "tool"; tool_call_id: string; content: string } & Record<string, unknown>);

const TOOL_HINT = "（我多次尝试调用工具，但这里是纯聊天模式，已忽略。请直接用文字问我想了解的内容。）";

async function oneHop(
  upstream: string,
  apiKey: string,
  model: string,
  messages: WireTurn[],
  timeoutMs: number,
  noThink: boolean,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${upstream.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(
        noThink
          ? { model, messages, max_tokens: 1024, temperature: 0.4, chat_template_kwargs: { enable_thinking: false } }
          : { model, messages, max_tokens: 1024, temperature: 0.4 },
      ),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[] };
    const m = data.choices?.[0]?.message;
    return { content: m?.content ?? "", toolCalls: m?.tool_calls?.length ? m.tool_calls : [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function chatComplete(
  upstream: string,
  apiKey: string,
  model: string,
  messages: WireMessage[],
  timeoutMs: number,
  noThink: boolean,
): Promise<string> {
  // Security: never send tool_choice:"none" — bili transparently injects+executes its
  // compression tools proxy-side, and the field passes through to the model; suppressing
  // it kills compression. Hallucinated tool_calls (bili only intercepts its own names)
  // are closed like an agent would: feed a tool error back so the model answers in text.
  const convo: WireTurn[] = messages.map((m) => ({ ...m }) as WireTurn);
  for (let hop = 0; hop < 3; hop++) {
    const { content, toolCalls } = await oneHop(upstream, apiKey, model, convo, timeoutMs, noThink);
    if (!toolCalls.length) {
      const text = stripThink(content);
      if (!text) throw new Error("LLM returned empty content");
      return text;
    }
    convo.push({ role: "assistant", content, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      convo.push({
        role: "tool",
        tool_call_id: tc.id ?? "call_0",
        content: `工具 '${tc.function?.name ?? "unknown"}' 在纯聊天模式不可用。请直接用文字回答用户的问题。`,
      });
    }
  }
  return TOOL_HINT;
}
