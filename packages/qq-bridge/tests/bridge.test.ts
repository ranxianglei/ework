import { describe, test, expect } from "bun:test";
import { parseCommand } from "../src/router";
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
