// Chat mode: instant Q&A directly against the OpenAI-compatible endpoint.
// Issue mode (任务/#N/绑定) stays the path for long agent work — chat is for
// the conversational 90% of group traffic that never needs a session.

export interface ChatTurn {
  role: "user" | "assistant";
  name: string;
  content: string;
}

export const CHAT_SYSTEM_PROMPT = [
  "你是 QQ 群里的即时问答助手，背后是 ework 开发平台。",
  "风格：简短直接，能用一两句话说清的就别铺开；技术问题给结论和关键理由，需要展开再展开。",
  "群里成员通过 @你 提问。你看到的多轮对话里每条 user 消息前缀了提问者的昵称，注意区分不同人。",
  "如果请求明显是需要长时间执行的开发任务（改代码、查仓库、提交 PR），不要假装去做——建议对方发「任务 <标题>」创建 issue，AI agent 会接单处理。",
  "不知道就直说，不要编造。",
].join("\n");

// qwen-family heuristic: CJK ≈ 1 token/char, latin ≈ 1/4 — blended constant.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.75);
}

// Single-message hard cap so one pasted log cannot eat the whole budget.
export const CHAT_MSG_CHAR_CAP = 24000;

function capContent(text: string): string {
  return text.length > CHAT_MSG_CHAR_CAP ? text.slice(0, CHAT_MSG_CHAR_CAP) + "…（已截断）" : text;
}

// Keep the newest turns that fit the token budget (oldest dropped first).
export function trimToContext(
  history: ChatTurn[],
  maxContextTokens: number,
  reservedTokens: number,
): ChatTurn[] {
  const budget = Math.max(0, maxContextTokens - reservedTokens);
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!turn) continue;
    const cost = estimateTokens(turn.content);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(turn);
  }
  return kept;
}

export function buildChatMessages(
  history: ChatTurn[],
  question: ChatTurn,
  maxHistory: number,
  maxContextTokens: number,
): { role: string; name?: string; content: string }[] {
  const system = { role: "system", content: CHAT_SYSTEM_PROMPT };
  const recent = history.slice(-maxHistory);
  const kept = trimToContext(recent, maxContextTokens, estimateTokens(CHAT_SYSTEM_PROMPT) + estimateTokens(question.content));
  return [
    system,
    ...kept.map((t) => ({ role: t.role, name: t.name, content: capContent(t.content) })),
    { role: question.role, name: question.name, content: capContent(question.content) },
  ];
}

export async function chatComplete(
  apiBase: string,
  apiKey: string,
  model: string,
  messages: { role: string; name?: string; content: string }[],
  timeoutMs: number,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0.4 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("LLM returned empty content");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function splitForQQ(text: string, maxLen = 1500): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf("。", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(remaining.slice(0, cut + 1));
    remaining = remaining.slice(cut + 1);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
