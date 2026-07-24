import { beforeAll, describe, expect, test } from "bun:test";
import { initDB } from "../src/db";
import {
  ensureUser, createProject, createIssue, postComment, addReaction,
  listReactionsFor, createLabel, setIssueLabel, listLabelsForIssue,
  createAttachment, getAttachment, createUser, addProjectMember,
  listProjectMembersWithUsers, countComments, replaceCachedModels,
  listCachedModels, getUserByLogin, listUsers, createPat, listPatsForUser,
} from "../src/store";
import { createWebhook, listWebhooks } from "../src/webhooks";

const PREFIX = process.env.WORK_DB_PREFIX ?? "";

// Skipped in the default `bun test` run (no prefix). Executed only under
// `WORK_DB_PREFIX=test_ bun test tests/prefix.test.ts`, which loads db.ts
// with a non-empty prefix so only prefixed tables exist — any query with a
// bare (un-tokenized) table name hits a non-existent table and throws.
describe.skipIf(!PREFIX)("storage under WORK_DB_PREFIX", () => {
  beforeAll(async () => { await initDB(); });

  test("every prefixed table is reachable (catches un-tokenized bare refs)", async () => {
    const admin = await createUser({ login: "alice", password: "password123", is_admin: true });
    await ensureUser("bob", "human");
    const p = await createProject("dog", "repo", "desc");
    const issue = await createIssue(p.id, "title", "body", "alice");
    const c = await postComment(issue.id, "first!", "alice");
    await addReaction(c.id, "alice", "+1");
    await listReactionsFor([c.id]);
    const lab = await createLabel(p.id, "bug", "#ff0000");
    await setIssueLabel(issue.id, lab.id, true);
    await listLabelsForIssue(issue.id);
    await createAttachment({
      uuid: "deadbeef-1234", issue_id: issue.id, filename: "f.txt",
      content_type: "text/plain", size: 1, blob_path: "/tmp/f", uploaded_by: "alice",
    });
    await getAttachment("deadbeef-1234");
    await addProjectMember(p.id, "bob", "writer");
    await listProjectMembersWithUsers(p.id);
    expect(await countComments(issue.id)).toBe(1);
    await replaceCachedModels(["openai/gpt-4o-mini"]);
    await listCachedModels();
    await getUserByLogin("alice");
    await listUsers();
    await createWebhook({ project_id: p.id, url: "http://example.com/h", secret: "k", events: ["issues"] });
    await listWebhooks(p.id);
    const pat = await createPat({ user_login: "alice", name: "test-token" });
    await listPatsForUser("alice");
    expect(admin.login).toBe("alice");
    expect(pat.plaintext).toBeTruthy();
  });
});
