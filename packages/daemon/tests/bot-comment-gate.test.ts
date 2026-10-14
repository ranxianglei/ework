import { describe, expect, test, vi } from "bun:test";

describe("handleCommented skips machine comments", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(dupFound: boolean) {
    const findMessageByCommentId = vi.fn(async () => (dupFound ? { id: "existing" } : null));
    const findIssue = vi.fn(async () => null);
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.store = { findMessageByCommentId, findIssue };
    self.ensureOwned = vi.fn();
    self.startObserver = vi.fn();
    self.processingComments = new Set();
    return { self, findMessageByCommentId, findIssue };
  }

  const ref = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" };
  const issueData = { title: "t", body: "", state: "open", author: "someone" };

  test("bot-kind comments (CI failure notices) are dropped before any session routing", async () => {
    const { self, findMessageByCommentId, findIssue } = makeSelf(false);
    const tracker = {
      isBotUser: (a: string) => a === "ework-daemon",
      createComment: vi.fn(),
    };
    const comment = { id: "c9", author: "github-actions[bot]", authorKind: "bot", body: "CI failed on master" };
    await Engine.prototype.handleCommented.call(self, ref, "acme/widgets", issueData, comment, tracker);
    expect(findMessageByCommentId).not.toHaveBeenCalled();
    expect(findIssue).not.toHaveBeenCalled();
  });

  test("human comments still pass the gate", async () => {
    const { self, findMessageByCommentId, findIssue } = makeSelf(true);
    const tracker = { isBotUser: () => false, createComment: vi.fn() };
    const comment = { id: "c10", author: "dog", authorKind: "user", body: "继续" };
    await Engine.prototype.handleCommented.call(self, ref, "acme/widgets", issueData, comment, tracker);
    expect(findMessageByCommentId).toHaveBeenCalledWith("c10");
    expect(findIssue).not.toHaveBeenCalled();
  });
});
