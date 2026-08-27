import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/store";
import { estimateTokens, capContent, windowFrom, buildChatMessages, CHAT_MSG_CHAR_CAP } from "../src/context";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ework-chat-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("context window", () => {
  test("estimateTokens is monotonic and capped content carries marker", () => {
    expect(estimateTokens("abcd")).toBe(3);
    expect(estimateTokens("a".repeat(100))).toBeLessThanOrEqual(estimateTokens("a".repeat(200)));
    const capped = capContent("x".repeat(CHAT_MSG_CHAR_CAP + 5));
    expect(capped.length).toBeLessThanOrEqual(CHAT_MSG_CHAR_CAP + 10);
    expect(capped.endsWith("…（已截断）")).toBe(true);
  });

  test("windowFrom is sticky under limits and bulk-cuts on crossing", () => {
    const sys = "sys";
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, name: `u${i}`, content: `msg-${i}-xxxxxxxx` }));
    // under limits: never moves
    expect(windowFrom(turns, 0, 500, 200000, sys)).toBe(0);
    // count limit 2 rounds: 10 turns → floor(4*0.7)=2 kept
    const cut = windowFrom(turns, 0, 2, 200000, sys);
    expect(cut).toBe(8);
    // sticky: same input from cut position stays
    expect(windowFrom(turns, cut, 2, 200000, sys)).toBe(cut);
    // append-only growth after cut: window only extends forward
    const grown = [...turns, { role: "assistant" as const, name: "", content: "reply" }];
    expect(windowFrom(grown, cut, 2, 200000, sys)).toBe(cut);
  });

  test("windowFrom with caps disabled (0) never evicts regardless of size", () => {
    const sys = "sys";
    const big = Array.from({ length: 5000 }, (_, i) => ({
      role: "user" as const, name: `u${i}`, content: `msg-${i}-${"x".repeat(200)}`,
    }));
    expect(windowFrom(big, 0, 0, 0, sys)).toBe(0);
    // single-dimension disable: only the active dimension can evict
    const small = big.slice(0, 4);
    expect(windowFrom(small, 0, 0, 200000, sys)).toBe(0);
    expect(windowFrom(small, 0, 500, 0, sys)).toBe(0);
    // a stale prevFrom from a capped era is clamped but not further advanced
    expect(windowFrom(big, 4998, 0, 0, sys)).toBe(4998);
  });

  test("built prompt prefix is byte-identical between evictions", () => {
    const sys = "sys";
    let history: { role: "user" | "assistant"; name: string; content: string }[] = [];
    let from = 0;
    const prefixes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const turn = { role: "user" as const, name: "u", content: `turn-${i}-yyyyyyyy` };
      history = [...history, turn];
      from = windowFrom(history, from, 2, 200000, sys);
      const windowed = history.slice(from);
      const q = windowed[windowed.length - 1] ?? turn;
      const msgs = buildChatMessages(windowed.slice(0, -1), q, sys);
      prefixes.push(JSON.stringify(msgs));
      history = [...history, { role: "assistant" as const, name: "", content: `r-${i}` }];
      from = windowFrom(history, from, 2, 200000, sys);
    }
    for (let i = 1; i < prefixes.length; i++) {
      const prevMsgs = JSON.parse(prefixes[i - 1] ?? "[]") as { content: string }[];
      const curMsgs = JSON.parse(prefixes[i] ?? "[]") as { content: string }[];
      const prevCtx = prevMsgs.slice(0, -1);
      const curCtx = curMsgs.slice(0, -1);
      // pure append: cur context's leading elements are byte-equal to prev context
      const isAppend = prevCtx.length <= curCtx.length && JSON.stringify(curCtx.slice(0, prevCtx.length)) === JSON.stringify(prevCtx);
      if (isAppend) continue;
      // otherwise it must be a one-time bulk shrink
      expect(curMsgs.length).toBeLessThan(prevMsgs.length);
    }
  });
});

describe("conversation store", () => {
  test("append + reload round-trip with timestamps", () => {
    const s = new ConversationStore(join(dir, "a"));
    s.append("g1", { role: "user", name: "alice", content: "hi" });
    s.append("g1", { role: "assistant", name: "", content: "hello" });
    const s2 = new ConversationStore(join(dir, "a"));
    expect(s2.history("g1")).toHaveLength(2);
    expect(s2.history("g1")[1]?.content).toBe("hello");
    expect(typeof s2.history("g1")[0]?.ts).toBe("string");
  });

  test("sendFrom survives reload; clamped to valid range", () => {
    const s = new ConversationStore(join(dir, "b"));
    for (let i = 0; i < 6; i++) s.append("g2", { role: i % 2 ? "assistant" : "user", name: "u", content: `m${i}` });
    s.setSendFrom("g2", 4);
    const s2 = new ConversationStore(join(dir, "b"));
    expect(s2.sendFrom("g2")).toBe(4);
  });

  test("trailing unanswered user turn is dropped on load (self-heal)", () => {
    const d = join(dir, "b2");
    const s = new ConversationStore(d);
    s.append("g2h", { role: "user", name: "u", content: "q1" });
    s.append("g2h", { role: "assistant", name: "", content: "a1" });
    s.append("g2h", { role: "user", name: "u", content: "poison" });
    const s2 = new ConversationStore(d);
    expect(s2.history("g2h")).toHaveLength(2);
    expect(s2.history("g2h")[1]?.content).toBe("a1");
  });

  test("torn tail line after crash is dropped, valid lines kept", () => {
    const d = join(dir, "c");
    const s = new ConversationStore(d);
    s.append("g3", { role: "user", name: "u", content: "good" });
    const file = join(d, "g3.jsonl");
    writeFileSync(file, readFileSync(file, "utf8") + '{"role":"user","name":"u","content":"tor');
    const s2 = new ConversationStore(d);
    expect(s2.history("g3")).toHaveLength(1);
    expect(s2.history("g3")[0]?.content).toBe("good");
  });

  test("unsafe conversation ids are hashed; delete removes files", () => {
    const s = new ConversationStore(join(dir, "d"));
    s.append("../etc/passwd", { role: "user", name: "u", content: "x" });
    const s2 = new ConversationStore(join(dir, "d"));
    expect(s2.history("../etc/passwd")).toHaveLength(1);
    expect(s2.delete("../etc/passwd")).toBe(true);
    expect(s2.delete("../etc/passwd")).toBe(false);
  });
});

describe("http service", () => {
  test("chat turn persists and a simulated restart keeps memory", async () => {
    const dataDir = join(dir, "svc");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
    const captured: string[] = [];
    const replies = ["记住暗号西瓜", "暗号是西瓜"];
    let call = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      captured.push(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: replies[call++] ?? "?" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const { loadConfig } = await import("../src/config");
      const { ConversationStore: S } = await import("../src/store");
      const { buildChatMessages: b, windowFrom: w, DEFAULT_SYSTEM_PROMPT: P } = await import("../src/context");
      const { chatComplete } = await import("../src/llm");
      const cfg = loadConfig({ CHAT_DATA_DIR: dataDir, CHAT_UPSTREAM: "http://x/v1", CHAT_MODEL: "m" });
      const ask = async (msg: string) => {
        const store = new S(cfg.DATA_DIR); // fresh instance = simulated restart
        store.append("1108730198", { role: "user", name: "dog", content: msg });
        const history = store.history("1108730198");
        const from = w(history, store.sendFrom("1108730198"), cfg.MAX_HISTORY, cfg.MAX_CONTEXT_TOKENS, P);
        store.setSendFrom("1108730198", from);
        const windowed = history.slice(from);
        const q = windowed[windowed.length - 1] ?? { role: "user" as const, name: "dog", content: msg };
        const reply = await chatComplete(cfg.UPSTREAM, cfg.API_KEY, cfg.MODEL, b(windowed.slice(0, -1), q, P), 5000, true);
        store.append("1108730198", { role: "assistant", name: "", content: reply });
        return reply;
      };
      const r1 = await ask("暗号是西瓜，记住了吗");
      expect(r1).toBe("记住暗号西瓜");
      const r2 = await ask("暗号是什么？");
      expect(r2).toBe("暗号是西瓜");
      // the second request body must contain the first turn (memory across restart)
      expect(captured[1]).toContain("暗号是西瓜，记住了吗");
      expect(captured[1]).toContain("记住暗号西瓜");
      // regression: tool_choice must never be sent — it passes through bili to the
      // model and would suppress the proxy-side compression tool calls
      for (const body of captured) expect(body).not.toContain("tool_choice");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
