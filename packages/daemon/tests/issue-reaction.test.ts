import { describe, expect, test, vi } from "bun:test";
import { GiteaTracker } from "../src/trackers/gitea-tracker";
import type { GiteaClient } from "../src/gitea";
import type { TrackerRef } from "../src/trackers/types";

function fakeClient() {
  return {
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
  } as unknown as GiteaClient;
}

const ref: TrackerRef = {
  trackerType: "gitea",
  scope: { owner: "acme", repo: "widgets" },
  issueId: "42",
};

function makeTracker() {
  const client = fakeClient();
  const tracker = new GiteaTracker(client as never, "http://gitea", "secret", "bot");
  return { tracker, client };
}

describe("setIssueReaction", () => {
  test("adds issue-level reaction via client.addReaction", async () => {
    const { tracker, client } = makeTracker();
    await tracker.setIssueReaction(ref, "eyes");
    expect(client.addReaction).toHaveBeenCalledWith("acme", "widgets", 42, "eyes");
    expect(client.removeReaction).not.toHaveBeenCalled();
  });

  test("remove flag routes to client.removeReaction", async () => {
    const { tracker, client } = makeTracker();
    await tracker.setIssueReaction(ref, "+1", true);
    expect(client.removeReaction).toHaveBeenCalledWith("acme", "widgets", 42, "+1");
    expect(client.addReaction).not.toHaveBeenCalled();
  });
});
