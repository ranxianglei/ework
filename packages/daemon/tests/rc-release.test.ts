import { describe, expect, it } from "bun:test";
import { eightQuestionRuleFor, RELEASE_PR_RE, RELEASE_REVIEW_RULE } from "../src/opencode";

// Owner policy 2026-11-17: a release PR is the highest-priority thread of
// the fleet. After the release v0.1.216 PR (2026-11-16) finished its worker
// run and sat unreviewed with no owner-facing verdict, release PRs get the
// 8-question release-review contract in the initial prompt plus a
// dispatch_priority stamp in handleOpened (release-worker session).
describe("eightQuestionRuleFor — release PRs", () => {
  it("matches bare and composed release-PR titles", () => {
    for (const t of [
      "[PR] release v0.1.216",
      "release v1.2.3",
      "[PR] Release v0.1.216 | release v0.1.216",
    ]) {
      expect(RELEASE_PR_RE.test(t)).toBe(true);
      expect(eightQuestionRuleFor(t)).toBe(RELEASE_REVIEW_RULE);
    }
  });

  it("release rule demands the 8问 checklist and a merge verdict", () => {
    expect(RELEASE_REVIEW_RULE).toContain("8问");
    expect(RELEASE_REVIEW_RULE).toContain("能否合并/发布");
    expect(RELEASE_REVIEW_RULE).toContain("(PR#NNNN review)");
  });

  it("does NOT match ordinary issue titles", () => {
    for (const t of [
      "Fix the login page crash",
      "[Bug] When the original anchor is missing, the compressed summary breaks",
      "Ship release notes automation",
    ]) {
      expect(eightQuestionRuleFor(t)).toBe("");
    }
  });

  it("RC rule still wins for [根因] titles even when they mention a release", () => {
    const rule = eightQuestionRuleFor("[根因] release v0.1.215 之后 CI 全线飘红");
    expect(rule).not.toBe("");
    expect(rule).toContain("Root-cause thread contract");
  });
});
