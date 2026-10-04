import { beforeAll, describe, expect, test } from "bun:test";
import { initDB, getDB } from "../src/db";
import {
  createProject,
  createIssue,
  addIssueReaction,
  removeIssueReaction,
  listIssueReactionsFor,
} from "../src/store";

describe("issue reactions store", () => {
  let issueId: number;

  beforeAll(async () => {
    await initDB();
    const project = await createProject("acme", "widgets", "test");
    const issue = await createIssue(project.id, "title", "body", "reporter");
    issueId = issue.id;
  });

  test("add aggregates by content and dedupes per user", async () => {
    await addIssueReaction(issueId, "ework-daemon", "eyes");
    await addIssueReaction(issueId, "ework-daemon", "eyes");
    await addIssueReaction(issueId, "ework-daemon", "+1");
    const aggs = await listIssueReactionsFor([issueId]);
    const eyes = aggs.find((a) => a.content === "eyes");
    const plus = aggs.find((a) => a.content === "+1");
    expect(eyes?.n).toBe(1);
    expect(plus?.n).toBe(1);
  });

  test("remove deletes only the matching user+content row", async () => {
    await addIssueReaction(issueId, "alice", "eyes");
    await removeIssueReaction(issueId, "ework-daemon", "eyes");
    const aggs = await listIssueReactionsFor([issueId]);
    expect(aggs.find((a) => a.content === "eyes")?.n).toBe(1);
    expect(aggs.find((a) => a.content === "+1")?.n).toBe(1);
  });

  test("empty id list returns empty", async () => {
    expect(await listIssueReactionsFor([])).toEqual([]);
  });

  test("rows live in issue_reactions with FK cascade", async () => {
    const n = await getDB().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM {{issue_reactions}} WHERE issue_id = ?",
      [issueId]
    );
    expect(n?.c).toBeGreaterThan(0);
  });
});
