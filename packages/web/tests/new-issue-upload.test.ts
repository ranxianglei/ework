import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  addProjectMember, createAttachment, createProject, createUser,
  ensureUser, getAttachment, getIssueWithMeta, getProject, createPat,
  bindOrphanAttachments, extractAttachmentUUIDs, sweepOrphanAttachments,
} from "../src/store";
import { getDB } from "../src/db";
import { initDB } from "../src/db";

// New-issue upload flow: uploads happen BEFORE the issue exists, so the route
// stores orphan rows (issue_id NULL) and issue-create binds them by uuid with
// an uploaded_by ownership guard. Sweep reaps never-bound orphans.

const REPO = "up-repo-" + (process.pid % 10000) + "-" + Math.floor(Math.random() * 10000);
const PORT = 4397 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
let authHeaders: Record<string, string> = {};

async function login(): Promise<void> {
  const pat = await createPat({ user_login: "up-admin", name: "upload-test" });
  authHeaders = { authorization: `token ${pat.plaintext}` };
}

let child: ReturnType<typeof Bun.spawn> | null = null;
let attRoot: string;
let serverStderrPath = "";

async function waitUntilUp(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status < 500) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`web did not come up on ${BASE}`);
}

beforeAll(async () => {
  await initDB();
  const admin = await createUser({ login: "up-admin", password: "password123", is_admin: true });
  await ensureUser("up-writer", "human");
  attRoot = mkdtempSync(join(tmpdir(), "ework-att-"));
  serverStderrPath = join(tmpdir(), `ework-web-server-${process.pid}-${PORT}.stderr.log`);
  const serverStderrFd = openSync(serverStderrPath, "w");
  child = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      WORK_PORT: String(PORT),
      WORK_TOKEN: process.env.WORK_TOKEN ?? "test-token-123",
      WORK_COOKIE_SECRET: process.env.WORK_COOKIE_SECRET ?? "test-cookie-secret-123",
      WORK_ATTACHMENT_ROOT: attRoot,
      WORK_DB_PATH: process.env.WORK_DB_PATH,
      WORK_WEBHOOK_SECRET: "whsec-test",
    },
    stdout: "ignore",
    stderr: serverStderrFd,
  });
  try {
    await waitUntilUp();
  } catch (err) {
    // The server's own output was previously discarded (stderr: "ignore"), so
    // a failed boot surfaced as a bare 20s timeout with zero diagnostics.
    let tail = "";
    try { tail = readFileSync(serverStderrPath, "utf8").slice(-2000); } catch { /* no output */ }
    const base = err instanceof Error ? err.message : String(err);
    throw new Error(`${base}\n--- spawned server stderr (tail) ---\n${tail || "(no output captured)"}`);
  }
  await login();
  const p = await getProject("up-owner", REPO);
  if (p) {
    await addProjectMember(p.id, "up-writer", "writer");
  }
  expect(admin.login).toBe("up-admin");
});

afterAll(() => {
  child?.kill();
  rmSync(attRoot, { recursive: true, force: true });
  try { rmSync(serverStderrPath, { force: true }); } catch {}
});

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function upload(body: FormData, auth = true): Promise<Response> {
  return fetch(`${BASE}/api/up-owner/${REPO}/upload`, {
    method: "POST",
    body,
    headers: auth ? authHeaders : {},
  });
}

describe("new-issue orphan upload flow", () => {
  test("orphan upload stores issue_id NULL and returns image markdown", async () => {
    const project = (await getProject("up-owner", REPO)) ?? (await createProject("up-owner", REPO, "d"));
    await addProjectMember(project.id, "up-admin", "admin");
    const fd = new FormData();
    fd.set("attachment", new File([PNG_1PX], "dot.png", { type: "image/png" }));
    const res = await upload(fd);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.markdown).toBe(`![dot.png](/attachments/${data.uuid})`);
    const row = await getAttachment(data.uuid);
    expect(row?.issue_id).toBeNull();
    expect(row?.uploaded_by).toBe("up-admin");
  });

  test("unauthenticated upload is rejected", async () => {
    const fd = new FormData();
    fd.set("attachment", new File([PNG_1PX], "x.png", { type: "image/png" }));
    const res = await upload(fd, false);
    expect(res.status).toBe(401);
  });

  test("create-issue binds own orphans referenced in body, not other users'", async () => {
    const fd = new FormData();
    fd.set("attachment", new File([PNG_1PX], "mine.png", { type: "image/png" }));
    const up = await (await upload(fd)).json();
    const foreign = await createAttachment({
      uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      issue_id: null,
      filename: "foreign.png",
      content_type: "image/png",
      size: PNG_1PX.length,
      blob_path: "/nonexistent/foreign.png",
      uploaded_by: "up-writer",
    });
    const body = `see ![mine](/attachments/${up.uuid}) and ![stolen](/attachments/${foreign.uuid})`;
    const res = await fetch(`${BASE}/up-owner/${REPO}/issues`, {
      method: "POST",
      body: new URLSearchParams({ title: "with attachments", body }),
      headers: authHeaders,
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get("location") ?? "";
    const num = Number(loc.match(/\/issues\/(\d+)$/)?.[1] ?? 0);
    expect(num).toBeGreaterThan(0);
    const project = await getProject("up-owner", REPO);
    const issue = await getIssueWithMeta(project!.id, num);
    expect(issue).not.toBeNull();
    const mine = await getAttachment(up.uuid);
    expect(mine?.issue_id).toBe(issue!.id);
    expect((await getAttachment(foreign.uuid))?.issue_id).toBeNull();
  });

  test("extractAttachmentUUIDs dedupes and skips short ids", () => {
    const out = extractAttachmentUUIDs(
      "x /attachments/11111111-2222-4333-8444-555555555555 y /attachments/11111111-2222-4333-8444-555555555555 z /attachments/short"
    );
    expect(out).toEqual(["11111111-2222-4333-8444-555555555555"]);
  });

  test("bindOrphanAttachments only claims own orphans", async () => {
    const project = await getProject("up-owner", REPO);
    const rows = await getDB().all<{ id: number }>("SELECT id FROM {{issues}} WHERE project_id = ? ORDER BY id DESC LIMIT 1", [project!.id]);
    const issueId = rows[0]!.id;
    const n = await bindOrphanAttachments(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], issueId, "up-admin");
    expect(n).toBe(0);
    expect((await getAttachment("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"))?.issue_id).toBeNull();
    const m = await bindOrphanAttachments(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], issueId, "up-writer");
    expect(m).toBe(1);
  });

  test("sweepOrphanAttachments reaps aged orphans and returns blob paths", async () => {
    const aged = await createAttachment({
      uuid: "99999999-8888-4777-8666-555555555555",
      issue_id: null,
      filename: "old.txt",
      content_type: "text/plain",
      size: 3,
      blob_path: "/tmp/sweep-me.txt",
      uploaded_by: "up-admin",
    });
    await getDB().run("UPDATE {{attachments}} SET created_at = ? WHERE uuid = ?", [
      new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
      aged.uuid,
    ]);
    const paths = await sweepOrphanAttachments(48 * 3600 * 1000);
    expect(paths).toContain("/tmp/sweep-me.txt");
    expect(await getAttachment(aged.uuid)).toBeNull();
  });
});
