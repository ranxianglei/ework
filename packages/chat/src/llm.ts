import { stripThink, type WireMessage } from "./context";

export async function chatComplete(
  upstream: string,
  apiKey: string,
  model: string,
  messages: WireMessage[],
  timeoutMs: number,
  noThink: boolean,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${upstream.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(
        noThink
          ? { model, messages, max_tokens: 1024, temperature: 0.4, chat_template_kwargs: { enable_thinking: false }, tool_choice: "none" }
          : { model, messages, max_tokens: 1024, temperature: 0.4, tool_choice: "none" },
      ),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: unknown[] } }[] };
    // Security: bili's injected tools sometimes elicit tool_calls here (content:"" → 502 loop).
    // tool_choice:"none" blocks new ones; this fallback keeps residual ones conversational.
    if (data.choices?.[0]?.message?.tool_calls?.length) {
      return "（我刚才试图调用工具，但这里是纯聊天模式，已忽略。请换个问法，或换个话题。）";
    }
    const text = stripThink(data.choices?.[0]?.message?.content ?? "");
    if (!text) throw new Error("LLM returned empty content");
    return text;
  } finally {
    clearTimeout(timer);
  }
}
