// Context management, ported from the battle-tested qq-bridge implementation.
// Key invariant: the SEND window must never slide. A sliding window re-derives
// "last N" every request, shifting the prompt prefix and missing the serving
// engine's prefix cache. Eviction is therefore bulk + sticky: no-op under the
// limits, one 30% cut on crossing, append-only between cuts.
// The DISK log keeps every turn forever (agent-style); eviction only moves the
// send-window start offset (persisted in a sidecar meta file).

export interface ChatTurn {
  role: "user" | "assistant";
  name: string;
  content: string;
}

export const DEFAULT_SYSTEM_PROMPT = [
  "你是一个即时问答助手。风格：简短直接，能用一两句话说清的就别铺开。",
  "技术问题给结论和关键理由，需要展开再展开。不知道就直说，不要编造。",
].join("\n");

// qwen-family heuristic: CJK ≈ 1 token/char, latin ≈ 1/4 — blended constant.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.75);
}

// Single-message hard cap so one pasted log cannot eat the whole budget.
export const CHAT_MSG_CHAR_CAP = 24000;

export const TRIM_FLOOR_RATIO = 0.7;

export function capContent(text: string): string {
  return text.length > CHAT_MSG_CHAR_CAP ? text.slice(0, CHAT_MSG_CHAR_CAP) + "…（已截断）" : text;
}

function historyTokens(history: ChatTurn[]): number {
  return history.reduce((n, t) => n + estimateTokens(t.content), 0);
}

function reserveTokens(systemPrompt: string): number {
  return estimateTokens(systemPrompt) + estimateTokens("x".repeat(CHAT_MSG_CHAR_CAP));
}

// Returns the send-window start index for a full history: sticky under the
// limits (returns prevFrom unchanged), bulk-cut on crossing either limit.
export function windowFrom(
  history: ChatTurn[],
  prevFrom: number,
  maxHistory: number,
  maxContextTokens: number,
  systemPrompt: string,
): number {
  const countLimit = Math.max(2, maxHistory * 2);
  const tokenLimit = Math.max(0, maxContextTokens - reserveTokens(systemPrompt));
  const from = Math.min(prevFrom, Math.max(0, history.length - 2));
  const visible = history.slice(from);
  if (visible.length <= countLimit && historyTokens(visible) <= tokenLimit) return from;
  const countFloor = Math.max(2, Math.floor(countLimit * TRIM_FLOOR_RATIO));
  const tokenFloor = Math.floor(tokenLimit * TRIM_FLOOR_RATIO);
  let start = from;
  let total = historyTokens(visible);
  while (start < history.length && (history.length - start > countFloor || total > tokenFloor)) {
    const turn = history[start];
    if (!turn) break;
    total -= estimateTokens(turn.content);
    start++;
  }
  return start;
}

export interface WireMessage {
  role: string;
  name?: string;
  content: string;
}

export function buildChatMessages(
  history: ChatTurn[],
  question: ChatTurn,
  systemPrompt: string,
): WireMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...history.map((t) => ({ role: t.role, name: t.name, content: capContent(t.content) })),
    { role: question.role, name: question.name, content: capContent(question.content) },
  ];
}

export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
