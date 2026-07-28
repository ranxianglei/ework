import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  StoreError,
  archiveLabel,
  createIssue,
  createLabel,
  createProject,
  deleteLabel,
  ensureUser,
  getLabel,
  labelScope,
  listLabels,
  listLabelsForIssue,
  setIssueLabel,
  setIssueLabels,
  updateLabel,
} from "../src/store";

beforeAll(async () => {
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["issue_labels", "labels", "issues", "projects", "users", "comments"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
  if (mysql) {
    for (const t of ["issues", "labels", "projects"]) {
      await db.exec(`ALTER TABLE {{${t}}} AUTO_INCREMENT = 1`);
    }
  } else {
    await db.exec("DELETE FROM sqlite_sequence WHERE name IN ('issues','labels','projects')");
  }
});

async function setupProject() {
  await ensureUser("dog");
  return createProject("dog", "labelrepo", "");
}

describe("labelScope", () => {
  test("extracts scope before first slash", () => {
    expect(labelScope("priority/high")).toBe("priority");
    expect(labelScope("type/bug")).toBe("type");
  });
  test("empty string for no slash", () => {
    expect(labelScope("bug")).toBe("");
    expect(labelScope("")).toBe("");
  });
  test("label starting with slash has no scope", () => {
    expect(labelScope("/leading")).toBe("");
  });
});

describe("createLabel", () => {
  test("creates with all fields", async () => {
    const p = await setupProject();
    const l = await createLabel(p.id, { name: "bug", color: "#ff0000", description: "defects", exclusive: false });
    expect(l.name).toBe("bug");
    expect(l.color).toBe("#ff0000");
    expect(l.description).toBe("defects");
    expect(l.exclusive).toBe(0);
    expect(l.is_archived).toBe(0);
  });

  test("rejects empty name", async () => {
    const p = await setupProject();
    await expect(createLabel(p.id, { name: "  ", color: "#000000" })).rejects.toThrow(StoreError);
  });

  test("rejects invalid color", async () => {
    const p = await setupProject();
    await expect(createLabel(p.id, { name: "x", color: "red" })).rejects.toThrow(StoreError);
    await expect(createLabel(p.id, { name: "x", color: "#fff" })).rejects.toThrow(StoreError);
    await expect(createLabel(p.id, { name: "x", color: "#GGGGGG" })).rejects.toThrow(StoreError);
  });

  test("rejects name with illegal chars", async () => {
    const p = await setupProject();
    await expect(createLabel(p.id, { name: "a;b", color: "#000000" })).rejects.toThrow(StoreError);
    await expect(createLabel(p.id, { name: "a!b", color: "#000000" })).rejects.toThrow(StoreError);
  });

  test("accepts scope/name syntax", async () => {
    const p = await setupProject();
    const l = await createLabel(p.id, { name: "priority/high", color: "#00ff00", exclusive: true });
    expect(l.name).toBe("priority/high");
    expect(l.exclusive).toBe(1);
  });

  test("description defaults to empty", async () => {
    const p = await setupProject();
    const l = await createLabel(p.id, { name: "x", color: "#000000" });
    expect(l.description).toBe("");
  });
});

describe("updateLabel", () => {
  test("partial update preserves other fields", async () => {
    const p = await setupProject();
    const l = await createLabel(p.id, { name: "bug", color: "#ff0000", description: "orig", exclusive: true });
    const updated = await updateLabel(p.id, l.id, { color: "#00ff00" });
    expect(updated.color).toBe("#00ff00");
    expect(updated.name).toBe("bug");
    expect(updated.description).toBe("orig");
    expect(updated.exclusive).toBe(1);
  });

  test("full update", async () => {
    const p = await setupProject();
    const l = await createLabel(p.id, { name: "old", color: "#111111" });
    const updated = await updateLabel(p.id, l.id, { name: "new", color: "#222222", description: "d", exclusive: true });
    expect(updated.name).toBe("new");
    expect(updated.exclusive).toBe(1);
  });

  test("404 on unknown label", async () => {
    const p = await setupProject();
    await expect(updateLabel(p.id, 99999, { name: "x" })).rejects.toThrow(StoreError);
  });
});

describe("archiveLabel / deleteLabel", () => {
  test("archive sets is_archived", async () => {
    const p = await setupProject();
    const l = await createLabel(p.id, { name: "x", color: "#000000" });
    const arch = await archiveLabel(p.id, l.id, true);
    expect(arch.is_archived).toBe(1);
    const restored = await archiveLabel(p.id, l.id, false);
    expect(restored.is_archived).toBe(0);
  });

  test("listLabels hides archived by default", async () => {
    const p = await setupProject();
    await createLabel(p.id, { name: "active", color: "#000000" });
    const arch = await createLabel(p.id, { name: "archived", color: "#000000" });
    await archiveLabel(p.id, arch.id, true);
    const visible = await listLabels(p.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.name).toBe("active");
    const all = await listLabels(p.id, true);
    expect(all).toHaveLength(2);
  });

  test("delete removes label and its issue associations", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const l = await createLabel(p.id, { name: "x", color: "#000000" });
    await setIssueLabel(issue.id, l.id, true);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(1);
    await deleteLabel(p.id, l.id);
    expect(await getLabel(p.id, l.id)).toBeNull();
    expect(await listLabelsForIssue(issue.id)).toHaveLength(0);
  });
});

describe("setIssueLabel exclusive-scope eviction", () => {
  test("attaching exclusive label evicts sibling in same scope", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const high = await createLabel(p.id, { name: "priority/high", color: "#ff0000", exclusive: true });
    const low = await createLabel(p.id, { name: "priority/low", color: "#00ff00", exclusive: true });
    await setIssueLabel(issue.id, high.id, true);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(1);
    await setIssueLabel(issue.id, low.id, true);
    const after = await listLabelsForIssue(issue.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.name).toBe("priority/low");
  });

  test("non-exclusive labels in same scope do not evict", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const a = await createLabel(p.id, { name: "scope/a", color: "#000000", exclusive: false });
    const b = await createLabel(p.id, { name: "scope/b", color: "#111111", exclusive: false });
    await setIssueLabel(issue.id, a.id, true);
    await setIssueLabel(issue.id, b.id, true);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(2);
  });

  test("different scopes do not evict each other", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const ph = await createLabel(p.id, { name: "p/high", color: "#000000", exclusive: true });
    const th = await createLabel(p.id, { name: "t/high", color: "#111111", exclusive: true });
    await setIssueLabel(issue.id, ph.id, true);
    await setIssueLabel(issue.id, th.id, true);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(2);
  });

  test("detach works", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const l = await createLabel(p.id, { name: "x", color: "#000000" });
    await setIssueLabel(issue.id, l.id, true);
    await setIssueLabel(issue.id, l.id, false);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(0);
  });

  test("re-attaching existing label is idempotent", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const l = await createLabel(p.id, { name: "x", color: "#000000" });
    await setIssueLabel(issue.id, l.id, true);
    await setIssueLabel(issue.id, l.id, true);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(1);
  });
});

describe("setIssueLabels (bulk replace)", () => {
  test("replaces full set", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const a = await createLabel(p.id, { name: "a", color: "#000000" });
    const b = await createLabel(p.id, { name: "b", color: "#111111" });
    const c = await createLabel(p.id, { name: "c", color: "#222222" });
    await setIssueLabels(issue.id, [a.id, b.id]);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(2);
    await setIssueLabels(issue.id, [c.id]);
    const after = await listLabelsForIssue(issue.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.name).toBe("c");
  });

  test("empty array clears all", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const a = await createLabel(p.id, { name: "a", color: "#000000" });
    await setIssueLabels(issue.id, [a.id]);
    await setIssueLabels(issue.id, []);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(0);
  });

  test("deduplicates ids", async () => {
    const p = await setupProject();
    const issue = await createIssue(p.id, "t", "b", "dog");
    const a = await createLabel(p.id, { name: "a", color: "#000000" });
    await setIssueLabels(issue.id, [a.id, a.id, a.id]);
    expect(await listLabelsForIssue(issue.id)).toHaveLength(1);
  });
});
