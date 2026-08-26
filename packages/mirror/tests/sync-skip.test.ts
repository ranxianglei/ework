import { describe, expect, test } from "bun:test";
import { isImportedComment, isImportedIssue, scrubInternalRefs } from "../src/mirror";

const base = { issue: { number: 5, upstream_issue_number: null as number | null }, comment: undefined as { body?: string } | undefined };

describe("echo guards", () => {
  test("comment with upstream-sync marker is imported", () => {
    expect(isImportedComment({ comment: { body: "hello\n<!-- upstream-sync -->" } })).toBe(true);
  });

  test("AI reply on an imported issue is NOT skipped as a comment", () => {
    expect(isImportedComment({ comment: { body: "[bot] done" } })).toBe(false);
  });

  test("issue with upstream number is imported (opened never twins)", () => {
    expect(isImportedIssue({ issue: { number: 5, upstream_issue_number: 329 } })).toBe(true);
  });

  test("locally born issue is not imported", () => {
    expect(isImportedIssue({ issue: { number: 5, upstream_issue_number: null } })).toBe(false);
  });
});

describe("scrubInternalRefs", () => {
  const cfg = { WORK_SCRUB_HOSTS: "internal.example,box-one" } as never;

  test("redacts configured hostnames and RFC1918 addresses", () => {
    const out = scrubInternalRefs(
      "see http://internal.example:1197/x and 10.0.2.2 and 172.16.5.4 from box-one",
      cfg
    );
    expect(out).not.toContain("internal.example");
    expect(out).not.toContain("10.0.2.2");
    expect(out).not.toContain("172.16.5.4");
    expect(out).not.toContain("box-one");
    expect(out).toContain("[internal-host]");
    expect(out).toContain("[internal-ip]");
  });

  test("leaves normal content, public hosts and unlisted hostnames intact", () => {
    const src = "fixed via https://github.com/o/r/pull/1, closes #231, model qwen3.8-27b, host elsewhere.org";
    expect(scrubInternalRefs(src, cfg)).toBe(src);
  });
});

test("mirrored issue footer carries provenance marker and no origin URL", async () => {
  const { mirrorFooter } = await import("../src/mirror");
  const footer = mirrorFooter(238);
  expect(footer).toContain("<!-- ework-mirror -->");
  expect(footer).toContain("Mirrored from ework issue #238");
  expect(footer).not.toContain("http");
});

describe("agent provenance badge", () => {
  test("footer includes model when provided", async () => {
    const { agentFooter } = await import("../src/mirror");
    const f = agentFooter("vllm-qwen/qwen3.8-27b");
    expect(f).toContain("🤖 ework agent");
    expect(f).toContain("vllm-qwen/qwen3.8-27b");
    expect(f).toContain("<sub>");
  });

  test("footer degrades gracefully without model", async () => {
    const { agentFooter } = await import("../src/mirror");
    expect(agentFooter(undefined)).toBe("\n\n<sub>🤖 ework agent</sub>");
    expect(agentFooter("")).toBe("\n\n<sub>🤖 ework agent</sub>");
  });

  test("parseEvent surfaces payload model and comment author", async () => {
    const { parseEvent } = await import("../src/ework");
    const payload = JSON.stringify({
      action: "created",
      repository: { name: "billion-context", owner: { login: "ranxianglei" }, ework_model: "vllm-qwen/qwen3.8-27b" },
      issue: { number: 5, title: "t" },
      comment: { id: 9, body: "[bot] done", user: { login: "ework-daemon" } },
      sender: { login: "ework-daemon" },
    });
    const ev = parseEvent(payload, "issue_comment");
    if (ev.kind !== "issue_comment") throw new Error("wrong kind");
    expect(ev.model).toBe("vllm-qwen/qwen3.8-27b");
    expect(ev.senderLogin).toBe("ework-daemon");
  });

  test("agentLogins parses env list with default", async () => {
    const { agentLogins } = await import("../src/mirror");
    expect(agentLogins({ WORK_AGENT_LOGINS: "ework-daemon, second-bot " } as never)).toEqual([
      "ework-daemon",
      "second-bot",
    ]);
  });
});

describe("close-state upstream fallback", () => {
  test("echo-linked issue resolves to upstream number, not retroactive twin", async () => {
    const { initDB } = await import("../src/db");
    initDB(`/tmp/qq-bridge-test-${process.pid}/mirror.db`);
    const { upstreamMap } = await import("../src/mirror");
    const row = upstreamMap(
      { projectOwner: "ranxianglei", projectName: "billion-context", issue: { number: 255, upstream_issue_number: 255, title: "t" } },
      { owner: "ranxianglei", repo: "billion-context" }
    );
    expect(row?.gitea_issue_num).toBe(255);
  });

  test("unlinked issue resolves to null (retroactive path stays)", async () => {
    const { upstreamMap } = await import("../src/mirror");
    const row = upstreamMap(
      { projectOwner: "ranxianglei", projectName: "billion-context", issue: { number: 9, upstream_issue_number: null, title: "t" } },
      { owner: "ranxianglei", repo: "billion-context" }
    );
    expect(row).toBeNull();
  });
});
