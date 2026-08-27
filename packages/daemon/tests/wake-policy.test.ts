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

  test("project whitelist (extraLogins) admits vetted strangers, still no bots", () => {
    const c = cfg({ wakeLogins: ["dog", "ranxianglei"] });
    expect(wakePolicySkips(c, "stirp", "human", ["stirp"])).toBeNull();
    expect(wakePolicySkips(c, "some-bot", "bot", ["some-bot"])).toContain("not in wakeKinds");
    expect(wakePolicySkips(c, "stranger", "human", ["stirp"])).toContain("not in wakeLogins");
  });

  test("project whitelist does not override the blacklist", () => {
    const c = cfg({ wakeLogins: ["dog"], noWakeLogins: ["stirp"] });
    expect(wakePolicySkips(c, "stirp", "human", ["stirp"])).toContain("non-waking author");
  });
});

describe("buildForwardPrompt trust marker", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };
  const mk = (wakeLogins: string[]) => {
    const self = Object.create(Engine.prototype) as { cfg: unknown };
    self.cfg = { daemon: { wakeLogins, noWakeLogins: [], nonWakingAuthors: [] } };
    return self as never;
  };

  const call = (self: never, user: string) =>
    Engine.prototype.buildForwardPrompt.call(self, "fwd", "do x", user, "human", "T", "/w", { issueRef: "o/r#1" }) as string;

  test("whitelisted author renders plain", () => {
    const p = call(mk(["dog"]), "dog");
    expect(p).toContain("@dog (user) posted");
    expect(p).not.toContain("unverified");
  });

  test("stranger renders unverified + injection warning", () => {
    const p = call(mk(["dog"]), "evil-stranger");
    expect(p).toContain("(unverified outside user)");
    expect(p).toContain("prompt injection");
  });

  test("blacklisted author is untrusted even without whitelist", () => {
    const { Engine } = require("../src/opencode") as { Engine: any };
    const self = Object.create(Engine.prototype) as { cfg: unknown };
    self.cfg = { daemon: { wakeLogins: [], noWakeLogins: ["evil-bot"], nonWakingAuthors: [] } };
    const p = Engine.prototype.buildForwardPrompt.call(self, "fwd", "do x", "evil-bot", "human", "T", "/w", { issueRef: "o/r#1" }) as string;
    expect(p).toContain("unverified");
  });
});
