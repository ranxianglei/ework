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
