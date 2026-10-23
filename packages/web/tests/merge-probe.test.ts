import { describe, test, expect } from "bun:test";
import { mergeProbeCandidates, prMergeState, MERGE_PROBE_PER_POLL, type GiteaIssue } from "../src/upstream-sync";

function pr(number: number, updatedAt: string, state = "open"): GiteaIssue {
  return { number, title: `pr ${number}`, body: "", state, user: { login: "u" }, created_at: updatedAt, updated_at: updatedAt, pull_request: {} };
}

describe("mergeProbeCandidates", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");

  test("picks open PRs updated within the 48h window", () => {
    const issues = [
      pr(1, "2026-10-05T11:00:00Z"),
      pr(2, "2026-10-04T13:00:00Z"),
      pr(7, "2026-10-03T13:00:00Z"), // 47h old — inside the 48h window
    ];
    const got = mergeProbeCandidates(issues, new Map(), now);
    expect(got).toEqual([1, 2, 7]);
  });

  test("keeps 72h-old PRs in the 5d window but skips older, closed, and plain issues", () => {
    const issues = [
      pr(3, "2026-10-02T13:00:00Z"), // 3 days old — inside the 5-day window
      pr(8, "2026-09-29T11:00:00Z"), // 6 days old — outside the 5-day window
      pr(4, "2026-10-05T11:00:00Z", "closed"),
      { ...pr(5, "2026-10-05T11:00:00Z"), pull_request: undefined },
    ];
    const got = mergeProbeCandidates(issues, new Map(), now);
    expect(got).toEqual([3]);
  });

  test("skips PRs whose updated_at has not moved since the last probe", () => {
    const issues = [pr(6, "2026-10-05T10:00:00Z")];
    const checked = new Map([[6, "2026-10-05T10:00:00Z"]]);
    expect(mergeProbeCandidates(issues, checked, now)).toEqual([]);
    const moved = new Map([[6, "2026-10-05T09:00:00Z"]]);
    expect(mergeProbeCandidates(issues, moved, now)).toEqual([6]);
  });

  test("caps candidates per poll", () => {
    const issues = Array.from({ length: 9 }, (_, i) => pr(10 + i, "2026-10-05T11:00:00Z"));
    const got = mergeProbeCandidates(issues, new Map(), now);
    expect(got.length).toBe(MERGE_PROBE_PER_POLL);
    expect(got).toEqual([10, 11, 12, 13, 14]);
  });
});

describe("prMergeState", () => {
  test("maps GitHub mergeable_state vocabulary", () => {
    expect(prMergeState({ mergeable: false, mergeable_state: "dirty" })).toBe("dirty");
    expect(prMergeState({ mergeable: true, mergeable_state: "behind" })).toBe("behind");
    expect(prMergeState({ mergeable: true, mergeable_state: "clean" })).toBe("clean");
  });

  test("pending when GitHub has not computed mergeable yet", () => {
    expect(prMergeState({ mergeable: null, mergeable_state: "unknown" })).toBe("pending");
  });

  test("falls back to the Gitea mergeable boolean", () => {
    expect(prMergeState({ mergeable: false })).toBe("dirty");
    expect(prMergeState({ mergeable: true })).toBe("clean");
  });
});
