import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  StoreError,
  countComments,
  createIssue,
  createProject,
  editIssue,
  ensureUser,
  getIssueById,
  getIssueWithMeta,
  getProject,
  listCommentsForIssue,
  listCommentsPage,
  postComment,
  setIssueState,
} from "../src/store";

beforeAll(async () => {
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of [
    "reactions",
    "comments",
    "issue_labels",
    "labels",
    "issues",
    "project_members",
    "webhooks",
    "webhook_deliveries",
    "personal_access_tokens",
    "attachments",
    "projects",
    "users",
  ]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
  if (mysql) {
    for (const t of ["issues", "comments", "projects", "labels", "webhooks", "webhook_deliveries", "personal_access_tokens"]) {
      await db.exec(`ALTER TABLE {{${t}}} AUTO_INCREMENT = 1`);
    }
  } else {
    await db.exec("DELETE FROM sqlite_sequence WHERE name IN ('issues','comments','projects')");
  }
});

const PROJECT_OWNER = "dog";
const PROJECT_NAME = "testrepo";
const AUTHOR = "alice";

async function seedProject() {
  await ensureUser(AUTHOR);
  return createProject(PROJECT_OWNER, PROJECT_NAME, "test desc");
}

describe("createIssue: default behaviour", () => {
  test("creates with server-now timestamps when no opts", async () => {
    const p = await seedProject();
    const before = Date.now();
    const issue = await createIssue(p.id, "title", "body", AUTHOR);
    const after = Date.now();

    expect(issue.number).toBe(1);
    expect(issue.state).toBe("open");
    expect(issue.closed_at).toBeNull();
    const created = Date.parse(issue.created_at);
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
  });

  test("increments number within project, isolated across projects", async () => {
    const p1 = await seedProject();
    await ensureUser("bob");
    const p2 = await createProject("dog", "other", "");
    await createIssue(p1.id, "t", "b", AUTHOR);
    const i2 = await createIssue(p1.id, "t", "b", AUTHOR);
    const j1 = await createIssue(p2.id, "t", "b", "bob");
    expect(i2.number).toBe(2);
    expect(j1.number).toBe(1);
  });

  test("rejects empty title", async () => {
    const p = await seedProject();
    await expect(createIssue(p.id, "   ", "b", AUTHOR)).rejects.toThrow(StoreError);
  });

  test("rejects title > 255 chars", async () => {
    const p = await seedProject();
    await expect(createIssue(p.id, "x".repeat(256), "b", AUTHOR)).rejects.toThrow(StoreError);
  });

  test("rejects body > 65536 chars", async () => {
    const p = await seedProject();
    await expect(createIssue(p.id, "t", "x".repeat(65537), AUTHOR)).rejects.toThrow(StoreError);
  });

  test("auto-creates missing user (ensureUser semantics)", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", "newuser");
    expect(issue.author).toBe("newuser");
  });
});

describe("createIssue: opts timestamp passthrough", () => {
  test("honours createdAt + updatedAt", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-02-01T00:00:00Z",
    });
    expect(issue.created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(issue.updated_at).toBe("2020-02-01T00:00:00.000Z");
    expect(issue.state).toBe("open");
    expect(issue.closed_at).toBeNull();
  });

  test("state=closed + closedAt stamps closed_at exactly", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00Z",
      state: "closed",
      closedAt: "2020-03-15T12:00:00Z",
    });
    expect(issue.state).toBe("closed");
    expect(issue.closed_at).toBe("2020-03-15T12:00:00.000Z");
  });

  test("state=closed without closedAt falls back to updatedAt then createdAt", async () => {
    const p = await seedProject();
    const a = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-02-01T00:00:00Z",
      state: "closed",
    });
    expect(a.closed_at).toBe("2020-02-01T00:00:00.000Z");

    const b = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00Z",
      state: "closed",
    });
    expect(b.closed_at).toBe("2020-01-01T00:00:00.000Z");
  });

  test("rejects garbage ISO timestamps", async () => {
    const p = await seedProject();
    await expect(
      createIssue(p.id, "t", "b", AUTHOR, { createdAt: "not-a-date" })
    ).rejects.toThrow(StoreError);
    await expect(
      createIssue(p.id, "t", "b", AUTHOR, { createdAt: "2020-13-45T99:99:99Z" })
    ).rejects.toThrow(StoreError);
  });

  test("normalizes timestamps to millisecond precision", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00", // no Z, no ms
      updatedAt: "2020-01-02T00:00:00+05:00",
    });
    expect(issue.created_at).toMatch(/\.\d{3}Z$/);
    expect(issue.updated_at).toMatch(/\.\d{3}Z$/);
  });
});

describe("setIssueState", () => {
  test("close writes closed_at, reopen clears it", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    expect(issue.closed_at).toBeNull();

    await setIssueState(issue.id, "closed", { closedAt: "2021-06-01T00:00:00Z" });
    expect((await getIssueById(issue.id))!.closed_at).toBe("2021-06-01T00:00:00.000Z");

    await setIssueState(issue.id, "open");
    expect((await getIssueById(issue.id))!.closed_at).toBeNull();
  });

  test("reclose without override uses now", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);

    await setIssueState(issue.id, "closed");
    const firstClose = (await getIssueById(issue.id))!.closed_at!;
    expect(Date.parse(firstClose)).toBeGreaterThan(0);

    await setIssueState(issue.id, "open");
    await setIssueState(issue.id, "closed");
    const secondClose = (await getIssueById(issue.id))!.closed_at!;
    expect(Date.parse(secondClose)).toBeGreaterThanOrEqual(Date.parse(firstClose));
  });

  test("accepts updatedAt override", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    await setIssueState(issue.id, "closed", {
      updatedAt: "2022-12-31T23:59:59Z",
      closedAt: "2022-12-31T23:59:59Z",
    });
    const after = (await getIssueById(issue.id))!;
    expect(after.updated_at).toBe("2022-12-31T23:59:59.000Z");
    expect(after.closed_at).toBe("2022-12-31T23:59:59.000Z");
  });
});

describe("editIssue: patch shapes", () => {
  test("title-only patch bumps updated_at", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
    });
    const before = Date.now();
    await editIssue(issue.id, { title: "new title" });
    const after = (await getIssueById(issue.id))!;
    expect(after.title).toBe("new title");
    expect(Date.parse(after.updated_at)).toBeGreaterThanOrEqual(before);
  });

  test("state patch writes closed_at consistently", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    await editIssue(issue.id, { state: "closed", closedAt: "2023-01-01T00:00:00Z" });
    expect((await getIssueById(issue.id))!.closed_at).toBe("2023-01-01T00:00:00.000Z");

    await editIssue(issue.id, { state: "open" });
    expect((await getIssueById(issue.id))!.closed_at).toBeNull();
  });

  test("updatedAt override is honored even without state change", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    await editIssue(issue.id, { body: "edited", updatedAt: "2019-05-05T05:05:05Z" });
    const after = (await getIssueById(issue.id))!;
    expect(after.body).toBe("edited");
    expect(after.updated_at).toBe("2019-05-05T05:05:05.000Z");
  });

  test("no-op patch returns without touching row", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
    });
    const before = (await getIssueById(issue.id))!;
    await editIssue(issue.id, {});
    const after = (await getIssueById(issue.id))!;
    expect(after).toEqual(before);
  });

  test("rejects invalid state", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    // @ts-expect-error — runtime guard against bad input
    await expect(editIssue(issue.id, { state: "merged" })).rejects.toThrow(StoreError);
  });
});

describe("postComment", () => {
  test("default uses server-now", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    const before = Date.now();
    const c = await postComment(issue.id, "hello", AUTHOR);
    expect(Date.parse(c.created_at)).toBeGreaterThanOrEqual(before);
    expect(c.body).toBe("hello");
  });

  test("honours createdAt + updatedAt overrides", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    const c = await postComment(issue.id, "hi", AUTHOR, {
      createdAt: "2018-03-03T03:03:03Z",
      updatedAt: "2018-03-04T04:04:04Z",
    });
    expect(c.created_at).toBe("2018-03-03T03:03:03.000Z");
    expect(c.updated_at).toBe("2018-03-04T04:04:04.000Z");
  });

  test("rejects empty body", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    await expect(postComment(issue.id, "   ", AUTHOR)).rejects.toThrow(StoreError);
  });

  test("bumps parent issue.updated_at", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR, {
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
    });
    await postComment(issue.id, "x", AUTHOR, { createdAt: "2021-01-01T00:00:00Z" });
    expect((await getIssueById(issue.id))!.updated_at).toBe("2021-01-01T00:00:00.000Z");
  });
});

describe("comment enumeration", () => {
  test("listCommentsPage returns chronological + clamps page", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    for (let i = 0; i < 5; i++) {
      await postComment(issue.id, `c${i}`, AUTHOR, {
        createdAt: `2020-01-0${i + 1}T00:00:00Z`,
      });
    }
    const page1 = await listCommentsPage(issue.id, 1, 2);
    expect(page1.rows.length).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.rows[0]!.body).toBe("c0");

    const pageClamped = await listCommentsPage(issue.id, 99, 2);
    expect(pageClamped.page).toBe(3);
    expect(pageClamped.rows[0]!.body).toBe("c4");
  });

  test("listCommentsForIssue returns all", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    await postComment(issue.id, "a", AUTHOR);
    await postComment(issue.id, "b", AUTHOR);
    expect((await listCommentsForIssue(issue.id)).length).toBe(2);
    expect(await countComments(issue.id)).toBe(2);
  });
});

describe("getIssueWithMeta", () => {
  test("joins project + counts comments", async () => {
    const p = await seedProject();
    const issue = await createIssue(p.id, "t", "b", AUTHOR);
    await postComment(issue.id, "x", AUTHOR);
    await postComment(issue.id, "y", AUTHOR);
    const view = await getIssueWithMeta(p.id, issue.number);
    expect(view).toBeDefined();
    expect(view!.comment_count).toBe(2);
    expect(view!.project_owner).toBe(PROJECT_OWNER);
    expect(view!.project_name).toBe(PROJECT_NAME);
  });

  test("returns null for missing number", async () => {
    const p = await seedProject();
    expect(await getIssueWithMeta(p.id, 999)).toBeNull();
  });
});

describe("getProject", () => {
  test("lookup by owner + name", async () => {
    await seedProject();
    const p = await getProject(PROJECT_OWNER, PROJECT_NAME);
    expect(p).toBeDefined();
    expect(p!.owner).toBe(PROJECT_OWNER);
  });

  test("returns null for missing", async () => {
    expect(await getProject("nobody", "nothing")).toBeNull();
  });
});
