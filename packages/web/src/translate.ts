import type { Config } from "./config";

export class TranslateError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TranslateError";
    this.status = status;
  }
}

const SYSTEM_PROMPT =
  "Translate the following English text to Simplified Chinese. Preserve ALL markdown formatting (bullet lists with - or *, **bold**, `code`, # headings). Output ONLY the translation, nothing else.";
const MAX_CHARS = 16_000;
const TIMEOUT_MS = 60_000;

// OpenAI-compatible chat-completion shapes (vLLM serves /v1/chat/completions).
interface ChatChoice {
  message?: { content?: unknown };
  delta?: { content?: unknown };
}
interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string } | string;
}

function endpoint(cfg: Config): string {
  return `${cfg.translateUrl.replace(/\/$/, "")}/chat/completions`;
}

export async function translateText(cfg: Config, text: string): Promise<string> {
  if (!cfg.translateUrl) throw new TranslateError("translation disabled", 503);
  const body = text.slice(0, MAX_CHARS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint(cfg), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.translateModel,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: body },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new TranslateError(`translate service unreachable: ${msg}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new TranslateError(`translate service → ${res.status}: ${t.slice(0, 200)}`, 502);
  }
  const data = (await res.json()) as ChatResponse;
  if (data.error) {
    const m = typeof data.error === "string" ? data.error : data.error.message;
    throw new TranslateError(m || "translate error", 502);
  }
  const content = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
  if (!content) throw new TranslateError("empty translation response", 502);
  return content;
}

// Streaming variant over the OpenAI-compatible /v1/chat/completions (vLLM).
// vLLM streams Server-Sent-Events: lines `data: {choices:[{delta:{content}}]}`
// terminated by `data: [DONE]`. Long input is split on sentence boundaries into
// ~CHUNK_CHARS chunks, each its own request with its own timeout (so total can
// exceed TIMEOUT_MS); yields are one continuous stream so the caller sees fluent
// output regardless of input length.
const CHUNK_CHARS = 2000;

export async function* translateTextStream(cfg: Config, text: string): AsyncGenerator<string> {
  if (!cfg.translateUrl) throw new TranslateError("translation disabled", 503);
  for (const chunk of splitChunks(text)) {
    yield* streamOneChunk(cfg, chunk);
  }
}

// Split on the last sentence boundary in the latter half of each max-sized window,
// so chunks stay readable and boundaries land on 。.!?…\n；;，, rather than mid-word.
function splitChunks(text: string, max = CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const lo = start + Math.floor(max / 2);
      const window = text.slice(lo, end);
      const breaks = /[。.!?…！？\n；;，,]/g;
      let last = -1;
      let m: RegExpExecArray | null;
      while ((m = breaks.exec(window)) !== null) last = m.index;
      if (last >= 0) end = lo + last + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function* streamOneChunk(cfg: Config, chunk: string): AsyncGenerator<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint(cfg), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.translateModel,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: chunk },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new TranslateError(`translate service unreachable: ${msg}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new TranslateError(`translate service → ${res.status}: ${t.slice(0, 200)}`, 502);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") return;
      if (!payload) continue;
      let obj: ChatResponse;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.error) {
        const m = typeof obj.error === "string" ? obj.error : obj.error.message;
        throw new TranslateError(m || "translate error", 502);
      }
      const c = typeof obj.choices?.[0]?.delta?.content === "string" ? obj.choices[0].delta.content : "";
      if (c) yield c;
    }
  }
}
