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
