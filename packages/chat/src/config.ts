import { z } from "zod";

// ework-chat: standalone chat-only component.
// Chat has NO tools — the upstream (typically a bili transparent-compression
// proxy) may inject compression tool-calls server-side; from this service the
// conversation is plain user/assistant turns. Every turn is appended to a
// per-conversation JSONL file before/after the LLM call (agent-style
// durability: user input is never lost, even on crash before reply).

export interface ChatConfig {
  HOST: string;
  PORT: number;
  DATA_DIR: string;
  UPSTREAM: string;
  API_KEY: string;
  MODEL: string;
  TIMEOUT_MS: number;
  MAX_HISTORY: number;
  MAX_CONTEXT_TOKENS: number;
  NO_THINK: boolean;
  TOKEN: string;
}

function boolEnv(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return z.preprocess((x) => x === "1" || x === "true", z.boolean()).parse(v);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ChatConfig {
  const schema = z.object({
    CHAT_HOST: z.string().default("127.0.0.1"),
    CHAT_PORT: z.coerce.number().int().min(1).max(65535).default(8210),
    CHAT_DATA_DIR: z.string().default(""),
    CHAT_UPSTREAM: z.string().default(""),
    CHAT_API_KEY: z.string().default(""),
    CHAT_MODEL: z.string().default(""),
    CHAT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90000),
    CHAT_MAX_HISTORY: z.coerce.number().int().min(1).default(500),
    CHAT_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(1000).default(200000),
    CHAT_NO_THINK: z.preprocess((x) => x === undefined || x === "" || x === "1" || x === "true", z.boolean()).default(true),
    CHAT_TOKEN: z.string().default(""),
  });
  const raw = schema.parse(env);
  return {
    HOST: raw.CHAT_HOST,
    PORT: raw.CHAT_PORT,
    DATA_DIR: raw.CHAT_DATA_DIR || `${env.HOME ?? "."}/.ework-chat`,
    UPSTREAM: raw.CHAT_UPSTREAM,
    API_KEY: raw.CHAT_API_KEY,
    MODEL: raw.CHAT_MODEL,
    TIMEOUT_MS: raw.CHAT_TIMEOUT_MS,
    MAX_HISTORY: raw.CHAT_MAX_HISTORY,
    MAX_CONTEXT_TOKENS: raw.CHAT_MAX_CONTEXT_TOKENS,
    NO_THINK: raw.CHAT_NO_THINK,
    TOKEN: raw.CHAT_TOKEN,
  };
}
