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
          ? { model, messages, max_tokens: 1024, temperature: 0.4, chat_template_kwargs: { enable_thinking: false } }
          : { model, messages, max_tokens: 1024, temperature: 0.4 },
      ),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = stripThink(data.choices?.[0]?.message?.content ?? "");
    if (!text) throw new Error("LLM returned empty content");
    return text;
  } finally {
    clearTimeout(timer);
  }
}
