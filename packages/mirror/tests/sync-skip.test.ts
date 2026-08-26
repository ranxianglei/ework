import { describe, expect, test } from "bun:test";
import { isSyncedFromUpstream } from "../src/mirror";

const base = { issue: { number: 1, upstream_issue_number: null as number | null } };

describe("synced-from-upstream detection", () => {
  test("issue with upstream number is skipped", () => {
    expect(isSyncedFromUpstream({ ...base, issue: { number: 5, upstream_issue_number: 329 } })).toBe(true);
  });

  test("comment body carrying the sync marker is skipped", () => {
    expect(isSyncedFromUpstream({ ...base, comment: { body: "hello\n<!-- upstream-sync -->" } })).toBe(true);
  });

  test("locally-born issue and plain comment pass through", () => {
    expect(isSyncedFromUpstream({ ...base })).toBe(false);
    expect(isSyncedFromUpstream({ ...base, comment: { body: "plain human text" } })).toBe(false);
  });
});
