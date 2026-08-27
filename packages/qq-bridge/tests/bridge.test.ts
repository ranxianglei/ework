import { describe, test, expect } from "bun:test";
import { parseCommand } from "../src/router";
import { BindingStore } from "../src/bindings";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const pinFile = () => `${tmpdir()}/qqb-test-${randomUUID()}.json`;
const histFile = () => `${tmpdir()}/qqb-hist-${randomUUID()}.json`;
import { parseGroupMap, parseList } from "../src/config";
import { buildScrubber } from "../src/scrub";
import { verifySignature } from "../src/ingest";

describe("parseCommand", () => {
  test("create via 任务/task", () => {
    expect(parseCommand("任务 修复登录超时")).toEqual({ kind: "create", title: "修复登录超时" });
    expect(parseCommand("task add dark mode")).toEqual({ kind: "create", title: "add dark mode" });
    expect(parseCommand("新任务 优化缓存")).toEqual({ kind: "create", title: "优化缓存" });
  });

  test("comment via #N", () => {
    expect(parseCommand("#42 这个问题还在")).toEqual({ kind: "comment", number: 42, body: "这个问题还在" });
    expect(parseCommand("#123\n多行\n内容")).toEqual({ kind: "comment", number: 123, body: "多行\n内容" });
  });

  test("help keywords", () => {
    for (const k of ["帮助", "help", "查询"]) expect(parseCommand(k)?.kind).toBe("help");
  });

  test("unrecognized returns null", () => {
    expect(parseCommand("今天天气不错")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("#999")).toBeNull();
  });
});

describe("parseGroupMap", () => {
  test("valid mapping", () => {
    expect(parseGroupMap("123456:ranxianglei/billion-context, 987654:dog/test1")).toEqual([
      { groupId: 123456, owner: "ranxianglei", repo: "billion-context" },
      { groupId: 987654, owner: "dog", repo: "test1" },
    ]);
  });

  test("invalid entries throw", () => {
    expect(() => parseGroupMap("123456:billion-context")).toThrow();
    expect(() => parseGroupMap("abc:x/y")).toThrow();
    expect(() => parseGroupMap(",,")).toThrow();
  });
});

describe("buildScrubber", () => {
  test("scrubs RFC1918 IPs always", () => {
    const scrub = buildScrubber([]);
    expect(scrub("server at 192.168.1.5 and 10.0.0.2")).not.toContain("192.168.1.5");
    expect(scrub("server at 192.168.1.5 and 10.0.0.2")).not.toContain("10.0.0.2");
  });

  test("scrubs configured hosts but keeps others", () => {
    const scrub = buildScrubber(["internal.example", "box-one"]);
    const out = scrub("see internal.example and box-one but example.org is fine");
    expect(out).toContain("[内部主机]");
    expect(out).toContain("example.org");
  });
});

describe("verifySignature", () => {
  test("valid HMAC passes", () => {
    const body = JSON.stringify({ a: 1 });
    const crypto = require("node:crypto");
    const mac = `sha256=${crypto.createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifySignature("secret", body, mac)).toBe(true);
  });

  test("wrong signature and missing header fail; empty secret allows", () => {
    expect(verifySignature("secret", "x", "sha256=deadbeef")).toBe(false);
    expect(verifySignature("secret", "x", null)).toBe(false);
    expect(verifySignature("", "x", null)).toBe(true);
  });
});

test("helps when @bot without verb", () => {
  expect(parseCommand("[CQ:at,qq=2661222094] 测试2")).toBeNull();
});

describe("@bot unified routing", () => {
  const mk = (bs: BindingStore) => {
    const { createRouter } = require("../src/router");
    const replies: string[] = [];
    const comments: Array<[string, string, number, string]> = [];
    const router = createRouter({
      cfg: { VERBOSE: false },
      bindings: bs,
      wakeList: new Set(["1"]),
      ework: { createIssue: async () => 9, addComment: async (o: string, r: string, n: number, b: string) => { comments.push([o, r, n, b]); } },
      store: { seenPost: () => false },
      reply: async (_g: number, x: string) => { replies.push(x); },
    });
    return { router, replies, comments };
  };
  const ev = (postId: string, raw: string) => ({ groupId: 1, userId: 1, nickname: "u", postId, rawMessage: raw });

  test("pinned: @bot falls to bound issue when chat API unset", async () => {
    const { router, replies, comments } = mk(new BindingStore([{ groupId: 1, owner: "o", repo: "r", issue: 7 }], pinFile()));
    await router.handleGroupMessage(ev("p1", "[CQ:at,qq=2661222094] 这个报错啥意思"));
    expect(comments.length).toBe(1);
    expect(comments[0][2]).toBe(7);
    expect(comments[0][3]).toContain("这个报错啥意思");
    expect(comments[0][3]).not.toContain("CQ:at");
    expect(replies).toEqual([]);
  });

  test("pinned: @bot CQ-only payload silently dropped", async () => {
    const { router, replies, comments } = mk(new BindingStore([{ groupId: 1, owner: "o", repo: "r", issue: 7 }], pinFile()));
    await router.handleGroupMessage(ev("p2", "[CQ:at,qq=2661222094]"));
    expect(comments).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("unpinned: @bot question gets bind guidance", async () => {
    const { router, replies, comments } = mk(new BindingStore([{ groupId: 1, owner: "o", repo: "r" }], pinFile()));
    await router.handleGroupMessage(ev("p3", "[CQ:at,qq=2661222094] 你好呀"));
    expect(comments).toEqual([]);
    expect(replies[0]).toContain("绑定");
  });

  test("unpinned: plain chatter stays silent", async () => {
    const { router, replies, comments } = mk(new BindingStore([{ groupId: 1, owner: "o", repo: "r" }], pinFile()));
    await router.handleGroupMessage(ev("p4", "今天天气不错"));
    expect(comments).toEqual([]);
    expect(replies).toEqual([]);
  });
});

test("onebot close ignores non-active client (reconnect race)", () => {
  const { createOneBotServer } = require("../src/onebot");
  let ready = 0;
  const srv = createOneBotServer({ path: "/ws", accessToken: "t", onEvent: () => {}, onReady: () => { ready++; } });
  const fake = (id: string) => ({ id, send: () => {}, close: () => {} });
  const a = fake("a"), b = fake("b");
  srv.handlers.open(a);
  expect(ready).toBe(1);
  srv.handlers.open(b);
  expect(ready).toBe(2);
  srv.handlers.close(a);
  expect(srv.connected).toBe(true);
  srv.handlers.close(b);
  expect(srv.connected).toBe(false);
});


describe("issue pinning", () => {
  test("parseGroupMap accepts #N suffix and bare form", () => {
    const [pinned, bare] = parseGroupMap("111:o/r#7,222:o/r");
    expect(pinned.issue).toBe(7);
    expect(bare.issue).toBeUndefined();
  });

  test("parseCommand: 绑定/解绑", () => {
    expect(parseCommand("绑定 #7")).toEqual({ kind: "bind", number: 7 });
    expect(parseCommand("解绑")).toEqual({ kind: "unbind" });
  });

  test("BindingStore pin/unpin persist + groupsFor filter", () => {
    const f = pinFile();
    const bs = new BindingStore([{ groupId: 111, owner: "o", repo: "r" }, { groupId: 222, owner: "o", repo: "r" }], f);
    expect(bs.groupsFor("o", "r", 7)).toEqual([111, 222]);
    bs.pin(111, 7);
    expect(bs.groupsFor("o", "r", 7)).toEqual([111, 222]);
    expect(bs.groupsFor("o", "r", 8)).toEqual([222]);
    expect(bs.pin(999, 1)).toBeNull();
    const reloaded = new BindingStore([{ groupId: 111, owner: "o", repo: "r" }], f);
    expect(reloaded.resolve(111)?.issue).toBe(7);
    expect(reloaded.groupsFor("o", "r", 8)).toEqual([]);
    expect(reloaded.unpin(111)).toBe(true);
    expect(reloaded.groupsFor("o", "r", 8)).toEqual([111]);
  });

  test("router: pinned plain message comments bound issue silently", async () => {
    const { createRouter } = require("../src/router");
    const replies: string[] = [];
    const comments: Array<[string, string, number, string]> = [];
    const router = createRouter({
      cfg: { VERBOSE: false },
      bindings: new BindingStore([{ groupId: 1, owner: "o", repo: "r", issue: 7 }], pinFile()),
      wakeList: new Set(["1"]),
      ework: { createIssue: async () => 9, addComment: async (o: string, r: string, n: number, b: string) => { comments.push([o, r, n, b]); } },
      store: { seenPost: () => false },
      reply: async (_g: number, t: string) => { replies.push(t); },
    });
    await router.handleGroupMessage({ groupId: 1, userId: 1, nickname: "u", postId: "p1", rawMessage: "帮我看下这个报错" });
    expect(comments.length).toBe(1);
    expect(comments[0][2]).toBe(7);
    expect(comments[0][3]).toContain("帮我看下这个报错");
    expect(replies).toEqual([]);
  });

  test("router: 绑定 #5 pins group, then plain message targets #5", async () => {
    const { createRouter } = require("../src/router");
    const replies: string[] = [];
    const comments: Array<number, any> = [];
    const bs = new BindingStore([{ groupId: 1, owner: "o", repo: "r" }], pinFile());
    const router = createRouter({
      cfg: { VERBOSE: false },
      bindings: bs,
      wakeList: new Set(["1"]),
      ework: { createIssue: async () => 9, addComment: async (_o: any, _r: any, n: number) => { comments.push(n); } },
      store: { seenPost: () => false },
      reply: async (_g: number, t: string) => { replies.push(t); },
    });
    await router.handleGroupMessage({ groupId: 1, userId: 1, nickname: "u", postId: "p1", rawMessage: "绑定 #5" });
    expect(replies[0]).toContain("#5");
    await router.handleGroupMessage({ groupId: 1, userId: 1, nickname: "u", postId: "p2", rawMessage: "第二条消息" });
    expect(comments).toEqual([5]);
  });

  test("router: 任务 in pinned group creates AND rebinds", async () => {
    const { createRouter } = require("../src/router");
    const replies: string[] = [];
    const bs = new BindingStore([{ groupId: 1, owner: "o", repo: "r", issue: 3 }], pinFile());
    const router = createRouter({
      cfg: { VERBOSE: false },
      bindings: bs,
      wakeList: new Set(["1"]),
      ework: { createIssue: async () => 12, addComment: async () => {} },
      store: { seenPost: () => false },
      reply: async (_g: number, t: string) => { replies.push(t); },
    });
    await router.handleGroupMessage({ groupId: 1, userId: 1, nickname: "u", postId: "p1", rawMessage: "任务 新主题" });
    expect(replies[0]).toContain("#12");
    expect(replies[0]).toContain("#3");
    expect(bs.resolve(1)?.issue).toBe(12);
  });
});




describe("chat delegation to ework-chat", () => {
  test("router: @bot delegates to ework-chat service", async () => {
    const origFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ conversation: "1", reply: "秒回的答案" }), { status: 200 });
    }) as typeof fetch;
    try {
      const { createRouter } = require("../src/router");
      const replies: string[] = [];
      const comments: unknown[] = [];
      const router = createRouter({
        cfg: { VERBOSE: false, WORK_CHAT_URL: "http://127.0.0.1:8210", WORK_CHAT_TOKEN: "t0" },
        bindings: new BindingStore([{ groupId: 1, owner: "o", repo: "r", issue: 7 }], pinFile()),
        wakeList: new Set(["1"]),
        ework: { createIssue: async () => 9, addComment: async (...a: unknown[]) => { comments.push(a); } },
        store: { seenPost: () => false },
        reply: async (_g: number, x: string) => { replies.push(x); },
      });
      await router.handleGroupMessage({ groupId: 1, userId: 1, nickname: "小狗", postId: "c1", rawMessage: "[CQ:at,qq=2661222094] 快问快答" });
      expect(replies).toEqual(["秒回的答案"]);
      expect(comments).toEqual([]);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8210/v1/chat");
      expect(calls[0]?.body.conversation).toBe("1");
      expect(calls[0]?.body.message).toBe("快问快答");
      expect(calls[0]?.body.user).toBe("小狗");
      expect(typeof calls[0]?.body.system).toBe("string");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("router: chat failure surfaces error reply", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    try {
      const { createRouter } = require("../src/router");
      const replies: string[] = [];
      const router = createRouter({
        cfg: { VERBOSE: false, WORK_CHAT_URL: "http://x", WORK_CHAT_TOKEN: "" },
        bindings: new BindingStore([{ groupId: 1, owner: "o", repo: "r" }], pinFile()),
        wakeList: new Set(["1"]),
        ework: { createIssue: async () => 9, addComment: async () => {} },
        store: { seenPost: () => false },
        reply: async (_g: number, x: string) => { replies.push(x); },
      });
      await router.handleGroupMessage({ groupId: 1, userId: 1, nickname: "u", postId: "c3", rawMessage: "[CQ:at,qq=2661222094] 问点啥" });
      expect(replies[0]).toContain("❌ 问答失败");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
