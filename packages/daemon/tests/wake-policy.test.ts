import { describe, expect, test } from "bun:test";
import { wakePolicySkips } from "../src/opencode";

const cfg = (over: Partial<Parameters<typeof wakePolicySkips>[0]> = {}) => ({
  nonWakingAuthors: [] as string[],
  noWakeLogins: [] as string[],
  wakeLogins: [] as string[],
  wakeKinds: ["human"],
  ...over,
});

describe("wakePolicySkips (comments + issue_opened share it)", () => {
  test("whitelist blocks strangers and bots, admits members", () => {
    const c = cfg({ wakeLogins: ["dog", "ranxianglei"] });
    expect(wakePolicySkips(c, "stranger", "human")).toContain("not in wakeLogins");
    expect(wakePolicySkips(c, "github-actions[bot]", "bot")).toContain("not in wakeLogins");
    expect(wakePolicySkips(c, "dog", "human")).toBeNull();
    expect(wakePolicySkips(c, "ranxianglei", "human")).toBeNull();
  });

  test("issue openers default to human kind (no kind field in payload)", () => {
    expect(wakePolicySkips(cfg(), "anyone", "human")).toBeNull();
    expect(wakePolicySkips(cfg({ wakeKinds: ["bot"] }), "anyone", "human")).toContain("not in wakeKinds");
  });

  test("blacklist beats whitelist", () => {
    const c = cfg({ wakeLogins: ["dog"], noWakeLogins: ["dog"] });
    expect(wakePolicySkips(c, "dog", "human")).toContain("non-waking author");
  });

  test("kind filter still applies without whitelist", () => {
    const c = cfg();
    expect(wakePolicySkips(c, "x", "bot")).toContain("not in wakeKinds");
    expect(wakePolicySkips(c, "x", "human")).toBeNull();
  });
});
