import { stripThink, type WireMessage } from "./context";

type ToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };

type WireTurn =
  | ({ role: "system" | "user" | "assistant"; name?: string; content: string } & Record<string, unknown>)
  | ({ role: "tool"; tool_call_id: string; content: string } & Record<string, unknown>);

const TOOL_HINT = "（我多次尝试调用工具，但这里没有可用的工具通道。请直接用文字问我想了解的内容。）";

const TOOL_GATE_NOTE = (name: string) =>
  `工具 '${name}' 未由上下文代理执行（当前通道不支持透传）。请直接用文字回答用户的问题。`;

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
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1024,
        temperature: 0.4,
        stream: true,
        ...(noThink ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
    if (!res.body) throw new Error("LLM returned no stream");

    let content = "";
    const calls = new Map<number, ToolCall>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed: { choices?: { delta?: { content?: string; tool_calls?: ({ index?: number; id?: string; function?: { name?: string; arguments?: string } })[] } }[] };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (typeof delta?.content === "string") content += delta.content;
        for (const tc of delta?.tool_calls ?? []) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const cur: ToolCall = calls.get(idx) ?? { function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function = { ...(cur.function ?? { name: "" }), name: tc.function.name };
          if (tc.function?.arguments) cur.function = { ...(cur.function ?? { name: "" }), arguments: (cur.function?.arguments ?? "") + tc.function.arguments };
          calls.set(idx, cur);
        }
      }
    }
    return { content, toolCalls: calls.size ? [...calls.values()] : [] };
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
  // Security: stream:true is the channel where the proxy executes ALL its context
  // tools (acp_status/compress/decompress/search) server-side and forwards text
  // only — the non-stream JSON path auto-executes compress alone and forwards the
  // rest to the client. Never send tool_choice:"none": it passes through and would
  // suppress those proxy tools. Tool calls that still leak through (unsupported
  // upstream shapes) are closed agent-style with a tool-role error reply.
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
        content: TOOL_GATE_NOTE(tc.function?.name ?? "unknown"),
      });
    }
  }
  return TOOL_HINT;
}
