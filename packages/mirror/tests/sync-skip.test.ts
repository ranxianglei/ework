import { describe, expect, test } from "bun:test";
import { isImportedComment, isImportedIssue } from "../src/mirror";

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
  test("redacts internal hostnames and RFC1918 addresses", async () => {
    const { scrubInternalRefs } = await import("../src/mirror");
    const out = scrubInternalRefs(
      "see http://m1.redoxos.org:1197/x and 192.168.10.157:8199 plus 10.0.2.2 and 172.16.5.4 from ework-sandbox"
    );
    expect(out).not.toContain("redoxos");
    expect(out).not.toContain("192.168.10.157");
    expect(out).not.toContain("10.0.2.2");
    expect(out).not.toContain("172.16.5.4");
    expect(out).not.toContain("ework-sandbox");
    expect(out).toContain("[internal-host]");
    expect(out).toContain("[internal-ip]");
  });

  test("leaves normal content and public hosts intact", async () => {
    const { scrubInternalRefs } = await import("../src/mirror");
    const src = "fixed via https://github.com/o/r/pull/1, closes #231, model qwen3.8-27b";
    expect(scrubInternalRefs(src)).toBe(src);
  });
});
