/**
 * Identity-pin tests — 2026-11-01 dual-ledger fix (billion-context discussion #5312).
 *
 * Context: e-work's mirror assigns its own local numbers which drift from
 * GitHub's whenever discussions consume sequence slots, so a bare "#N" can
 * name one thread internally and a different thread on GitHub. This fix adds
 * (a) kind/upstream_issue_number passthrough on webhook events and (b) an
 * identity pin in every task prompt forbidding bare-"#N" lookups against the
 * upstream platform.
 */
import { describe, expect, test, vi } from "bun:test";
import { GiteaTracker } from "../src/trackers/gitea-tracker";

const makeTracker = () =>
  new GiteaTracker({} as never, "http://localhost:3300", "secret", "ework-daemon");

describe("GiteaTracker.parseWebhookEvent — thread-kind extraction", () => {
  test("extracts kind and upstream number from mirror payloads", () => {
    const t = makeTracker();
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        id: 9001,
        number: 5316,
        title: "[Q&A] which extension for pi?",
        body: "…",
        state: "open",
        user: { login: "richardaubin" },
        created_at: "2026-10-31T06:34:46Z",
        updated_at: "2026-10-31T06:34:46Z",
        kind: "discussion",
        upstream_issue_number: 5312,
      },
      repository: { owner: { login: "ranxianglei" }, name: "billion-context" },
      sender: { login: "richardaubin" },
    });
    const event = t.parseWebhookEvent(payload);
    expect(event).not.toBeNull();
    expect(event!.issue.kind).toBe("discussion");
    expect(event!.issue.upstreamIssueNumber).toBe(5312);
    expect(event!.ref.issueId).toBe("5316");
  });

  test("tolerates legacy payloads without kind/upstream number", () => {
    const t = makeTracker();
    const payload = JSON.stringify({
      action: "created",
      issue: {
        number: 7,
        title: "x",
        state: "open",
        user: { login: "alice" },
      },
      comment: { body: "please fix", user: { login: "bob" } },
      repository: { owner: { login: "acme" }, name: "widget" },
      sender: { login: "bob" },
    });
    const event = t.parseWebhookEvent(payload);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("comment_created");
    expect((event!.issue.kind ?? null) ?? undefined).toBeUndefined();
    expect(event!.issue.upstreamIssueNumber).toBeUndefined();
  });

  test("ignores bogus non-string kind and non-number upstream values", () => {
    const t = makeTracker();
    const base = {
      action: "opened",
      issue: { number: 8, title: "x", state: "open", user: { login: "a" } },
      repository: { owner: { login: "acme" }, name: "w" },
    };
    const badKind = t.parseWebhookEvent(
      JSON.stringify({ ...base, issue: { ...base.issue, kind: { nope: true } } }),
    );
    expect(badKind?.issue.kind).toBeUndefined();

    const badUpstream = t.parseWebhookEvent(
      JSON.stringify({ ...base, issue: { ...base.issue, upstream_issue_number: "53x" } }),
    );
    expect(badUpstream?.issue.upstreamIssueNumber).toBeUndefined();
  });
});

describe("identity pin in task prompts", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  const makeSelf = () => {
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.cfg = {
      bot: { username: "ework-daemon" },
      daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] },
      work: {},
    };
    self.isTrustedAuthor = vi.fn(() => false);
    return self;
  };

  const computeNote = (self: Record<string, unknown>, data?: unknown) =>
    Engine.prototype.identityNote.call(self, data) as string | null;

  const instructions = { clone: "git clone X", issueRef: "ranxianglei/billion-context#5316" };
  const issueDataPin = { kind: "discussion", upstreamIssueNumber: 5312 };

  test("identityNote builds the pin from kind+upstream number", () => {
    const self = makeSelf();
    const note = computeNote(self, issueDataPin);
    expect(note).toContain("Identity pin");
    expect(note).toContain("thread kind = discussion");
    expect(note).toContain("upstream GitHub number = 5312");
    expect(note).toContain('NEVER resolve a bare "#N" against GitHub');
    expect(computeNote(self, undefined)).toBeNull();
    expect(computeNote(self, {})).toBeNull();
  });

  test("buildInitialPrompt includes the pin when the event carries kind+upstream number", () => {
    const self = makeSelf();
    const prompt = String(
      Engine.prototype.buildInitialPrompt.call(
        self, "ework-daemon", "T", "B", "alice", "/tmp/wd", instructions, computeNote(self, issueDataPin),
      ),
    );
    expect(prompt).toContain("Identity pin");
    expect(prompt).toContain("thread kind = discussion");
    expect(prompt).toContain("upstream GitHub number = 5312");
    expect(prompt).toContain('NEVER resolve a bare "#N" against GitHub');
  });

  test("buildInitialPrompt omits the pin when there is no identity data", () => {
    const self = makeSelf();
    const prompt = String(
      Engine.prototype.buildInitialPrompt.call(
        self, "ework-daemon", "T", "B", "alice", "/tmp/wd", { ...instructions, issueRef: "acme/widget#7" }, undefined,
      ),
    );
    expect(prompt).not.toContain("Identity pin");
  });

  test("buildForwardPrompt appends the pin for comment forwards", () => {
    const self = makeSelf();
    const prompt = String(
      Engine.prototype.buildForwardPrompt.call(
        self, "ework-daemon", "please help", "alice", "human", "Issue title", "/tmp/wd",
        { issueRef: "ranxianglei/billion-context#5316" }, computeNote(self, issueDataPin), undefined, [],
      ),
    );
    expect(prompt).toContain('posted a new comment on ranxianglei/billion-context#5316 "Issue title".');
    expect(prompt).toContain("Identity pin");
    expect(prompt).toContain("thread kind = discussion");
    expect(prompt).toContain("upstream GitHub number = 5312");
  });

  test("buildForwardPrompt stays silent without identity data", () => {
    const self = makeSelf();
    const prompt = String(
      Engine.prototype.buildForwardPrompt.call(
        self, "ework-daemon", "please help", "alice", "human", "Issue title", "/tmp/wd",
        { issueRef: "acme/widget#7" },
      ),
    );
    expect(prompt).not.toContain("Identity pin");
  });
});

describe("global no-decision-issue rule in base prompts", () => {
  function engineSelf() {
    const { Engine } = require("../src/opencode");
    const self = Object.create(Engine.prototype);
    self.cfg = { bot: { username: "ework-daemon" }, daemon: {}, work: {} };
    return self;
  }

  test("buildInitialPrompt embeds the owner-policy ban on decision/follow-up issues", () => {
    const { Engine } = require("../src/opencode");
    const self = engineSelf();
    const prompt = Engine.prototype.buildInitialPrompt.call(
      self, "ework-daemon", "t", "b", "ranxianglei", "/wd",
      { clone: "git clone x .", issueRef: "acme/widgets#42" }, null,
    );
    expect(prompt).toContain("no new issues for decisions or follow-ups");
    expect(prompt).toContain("🔶 需要决策");
    expect(prompt).toContain("add-label.sh");
    expect(prompt).toContain("owner policy 2026-11-01");
  });

  test("buildInitialPrompt embeds the one-PR-per-thread + GitHub-number rule", () => {
    const { Engine } = require("../src/opencode");
    const self = engineSelf();
    const prompt = Engine.prototype.buildInitialPrompt.call(
      self, "ework-daemon", "t", "b", "ranxianglei", "/wd",
      { clone: "git clone x .", issueRef: "acme/widgets#42" }, null,
    );
    expect(prompt).toContain("one fix PR per thread; GitHub numbers outside the mirror");
    expect(prompt).toContain("per e-work#44 plan");
    expect(prompt).toContain("ADD your commits to that existing branch/PR instead of opening a parallel second one");
    expect(prompt).toContain("--jq .title and confirm its GitHub title actually matches");
    expect(prompt).toContain("/api/v1/issues?owner=");
    expect(prompt).toContain("Authorization: token $GITEA_TOKEN");
    expect(prompt).toContain("(.number|tostring)");
    expect(prompt).not.toContain("/api/<owner>/<repo>/issues");
  });
});
