import { describe, expect, test } from "bun:test";
import { wakePolicySkips, externalWakeAllotment } from "../src/opencode";

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

describe("externalWakeAllotment", () => {
  const day = 86_400_000;
  test("admits fresh authors and grows the retained window", () => {
    const r1 = externalWakeAllotment([], 1_000, 2);
    expect(r1.allowed).toBe(true);
    expect(r1.kept.length).toBe(1);
    const r2 = externalWakeAllotment(r1.kept, 2_000, 2);
    expect(r2.allowed).toBe(true);
    expect(r2.kept.length).toBe(2);
  });

  test("blocks at the limit without appending", () => {
    const stamps = [1_000, 2_000];
    const r = externalWakeAllotment(stamps, 3_000, 2);
    expect(r.allowed).toBe(false);
    expect(r.kept.length).toBe(2);
  });

  test("expires day-old stamps so the quota resets daily", () => {
    const stamps = [1_000, 2_000];
    const r = externalWakeAllotment(stamps, 1_000 + day + 5_000, 2);
    expect(r.allowed).toBe(true);
    expect(r.kept.length).toBe(1);
  });
});

describe("communityWakeAdmitted (opencode-acp#435)", () => {
  const { communityWakeAdmitted } = require("../src/opencode") as { communityWakeAdmitted: typeof import("../src/opencode").communityWakeAdmitted };

  test("message-board shape: opted-in project serves external human commenters", () => {
    expect(communityWakeAdmitted(true, "comment_created", "ranxianglei", "Bunny4Don", "human")).toBe(true);
  });

  test("issue author still admitted (own-issue trust)", () => {
    expect(communityWakeAdmitted(true, "comment_created", "Bunny4Don", "Bunny4Don", "human")).toBe(true);
    expect(communityWakeAdmitted(true, "issue_opened", "Bunny4Don", "Bunny4Don", "human")).toBe(true);
  });

  test("bots excluded by kind and by [bot] suffix", () => {
    expect(communityWakeAdmitted(true, "comment_created", "x", "github-actions[bot]", "bot")).toBe(false);
    expect(communityWakeAdmitted(true, "comment_created", "x", "github-actions[bot]", "human")).toBe(false);
    expect(communityWakeAdmitted(true, "issue_opened", "x", "renovate[bot]", "human")).toBe(false);
  });

  test("opted-out project and foreign issue_opened stay skipped", () => {
    expect(communityWakeAdmitted(false, "comment_created", "a", "b", "human")).toBe(false);
    expect(communityWakeAdmitted(true, "issue_opened", "a", "b", "human")).toBe(false);
  });
});

describe("collectUnansweredBacklog (opencode-acp#435)", () => {
  const { collectUnansweredBacklog } = require("../src/opencode") as { collectUnansweredBacklog: typeof import("../src/opencode").collectUnansweredBacklog };
  type C = Parameters<typeof collectUnansweredBacklog>[0][number];
  const mk = (id: string, author: string, body: string, createdAt?: string): C =>
    ({ id, author, body, createdAt }) as C;

  test("surfaces comments skipped since the last [bot] reply (#435 shape)", () => {
    const out = collectUnansweredBacklog([
      mk("1", "ework-daemon", "[system] 🏷 session started"),
      mk("2", "ework-daemon", "[bot] 🏷 留言板已就位"),
      mk("3", "Bunny4Don", "opencode-acp 失效了。如何排查", "2026-09-21T08:53:58Z"),
      mk("4", "dog", "继续", "2026-09-21T13:02:40Z"),
    ], "4");
    expect(out.length).toBe(1);
    expect(out[0]!.author).toBe("Bunny4Don");
    expect(out[0]!.body).toContain("如何排查");
    expect(out[0]!.createdAt).toBe("2026-09-21T08:53:58Z");
  });

  test("platform plumbing never anchors as an answer", () => {
    const out = collectUnansweredBacklog([
      mk("1", "ework-daemon", "[bot] 🏷 done"),
      mk("2", "stranger", "question A"),
      mk("3", "ework-daemon", "[system] 🏷 ✓ Message forwarded"),
      mk("4", "dog", "继续"),
    ], "4");
    expect(out.length).toBe(1);
    expect(out[0]!.body).toBe("question A");
  });

  test("no backlog once the agent replied after the question", () => {
    const out = collectUnansweredBacklog([
      mk("1", "stranger", "question A"),
      mk("2", "ework-daemon", "[bot] 🏷 answered it"),
      mk("3", "dog", "继续"),
    ], "3");
    expect(out.length).toBe(0);
  });

  test("truncates long bodies and caps at five entries", () => {
    const long = "x".repeat(1500);
    const many = Array.from({ length: 8 }, (_, i) => mk(`q${i}`, `u${i}`, long));
    const out = collectUnansweredBacklog([...many, mk("trig", "dog", "继续")], "trig");
    expect(out.length).toBe(5);
    expect(out[0]!.author).toBe("u3");
    expect(out[0]!.body.length).toBeLessThanOrEqual(1215);
    expect(out[0]!.body).toContain("(truncated)");
  });

  test("prefix-less bot comment is not backlogged (dog/tasks#18)", () => {
    const out = collectUnansweredBacklog([
      mk("1", "dog", "帮忙搞下"),
      mk("2", "awork", "## 结论先行：不建议走反编译这条路"),
      mk("trig", "dog", "还是反编译比较好 麻烦帮忙搞下吧"),
    ], "trig", (login) => login === "awork");
    expect(out.length).toBe(0);
  });

  test("prefix-less bot comment anchors the window for earlier human comments", () => {
    const out = collectUnansweredBacklog([
      mk("1", "dog", "旧问题"),
      mk("2", "awork", "## 已回答旧问题"),
      mk("3", "cat", "新问题"),
      mk("trig", "dog", "继续"),
    ], "trig", (login) => login === "awork");
    expect(out.length).toBe(1);
    expect(out[0]!.author).toBe("cat");
    expect(out[0]!.body).toBe("新问题");
  });

  test("without the bot predicate only prefixes count (old buggy behavior)", () => {
    const out = collectUnansweredBacklog([
      mk("1", "dog", "问题"),
      mk("2", "awork", "## 无前缀回复"),
      mk("trig", "dog", "继续"),
    ], "trig");
    expect(out.length).toBe(2);
    expect(out.map((e) => e.author)).toEqual(["dog", "awork"]);
  });
});

describe("buildForwardPrompt backlog rendering", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };
  const self = Object.create(Engine.prototype) as { cfg: unknown };
  self.cfg = { daemon: { wakeLogins: ["dog"], noWakeLogins: [], nonWakingAuthors: [] } };

  test("backlog entries render with per-author trust framing", () => {
    const p = Engine.prototype.buildForwardPrompt.call(
      self, "fwd", "继续", "dog", "human", "T", "/w", { issueRef: "o/r#1" }, [],
      [{ author: "Bunny4Don", authorKind: "human", body: "如何排查", createdAt: "2026-09-21T08:53:58Z" }],
    ) as string;
    expect(p).toContain("not been answered yet");
    expect(p).toContain("@Bunny4Don (user) (unverified outside user");
    expect(p).toContain("如何排查");
  });

  test("empty backlog keeps the prompt identical in shape", () => {
    const p = Engine.prototype.buildForwardPrompt.call(self, "fwd", "hi", "dog", "human", "T", "/w", { issueRef: "o/r#1" }, [], []) as string;
    expect(p).not.toContain("not been answered yet");
    expect(p).toContain("Reply using the `reply` tool.");
  }
);
});
