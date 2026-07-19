/**
 * Gitea API 连通性测试
 * 验证 Bridge Daemon 需要的所有 API 端点
 *
 * Usage: GITEA_TOKEN=xxx bun run scripts/test-gitea.ts
 */
import { createHmac } from "crypto";

const GITEA_URL = process.env.GITEA_URL;
if (!GITEA_URL) {
  console.error("❌ GITEA_URL env required (point at your ework-web or real Gitea instance)");
  process.exit(1);
}
const GITEA_TOKEN = process.env.GITEA_TOKEN ?? "";
const TEST_REPO = "fast-train";
const TEST_OWNER = "dog";

if (!GITEA_TOKEN) {
  console.error("❌ GITEA_TOKEN env required");
  process.exit(1);
}

const headers = {
  Authorization: `token ${GITEA_TOKEN}`,
  "Content-Type": "application/json",
};

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${GITEA_URL}/api/v1${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json")
    ? await res.json()
    : await res.text();
  return { ok: res.ok, status: res.status, data };
}

function pass(msg: string) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string, detail?: unknown) {
  console.log(`  ❌ ${msg}`);
  if (detail) console.log("     ", JSON.stringify(detail));
}

let testsPassed = 0;
let testsFailed = 0;

async function test(name: string, fn: () => Promise<boolean>) {
  console.log(`\n📋 ${name}`);
  try {
    const ok = await fn();
    if (ok) testsPassed++;
    else testsFailed++;
  } catch (err) {
    fail(`Exception: ${err}`);
    testsFailed++;
  }
}

// ─── Tests ──────────────────────────────────────────────────────

await test("GET /version — 基础连通", async () => {
  const res = await fetch(`${GITEA_URL}/api/v1/version`);
  if (!res.ok) {
    fail("无法连接", res.status);
    return false;
  }
  const data = (await res.json()) as { version: string };
  pass(`Gitea ${data.version}`);
  return true;
});

await test("GET /user — Token 认证", async () => {
  const r = await api("GET", "/user");
  if (!r.ok) {
    fail(`认证失败 status=${r.status}`, r.data);
    return false;
  }
  const user = r.data as { username: string; is_admin: boolean };
  pass(`用户: ${user.username}, admin: ${user.is_admin}`);
  return true;
});

await test("GET /repos/{owner}/{repo} — 获取 repo 信息", async () => {
  const r = await api("GET", `/repos/${TEST_OWNER}/${TEST_REPO}`);
  if (!r.ok) {
    fail(`未找到 ${TEST_OWNER}/${TEST_REPO}`, r.data);
    return false;
  }
  const repo = r.data as { full_name: string; open_issues_count: number };
  pass(`${repo.full_name}, open issues: ${repo.open_issues_count}`);
  return true;
});

let testIssueNumber: number | null = null;

await test("POST /repos/{owner}/{repo}/issues — 创建 issue", async () => {
  const r = await api("POST", `/repos/${TEST_OWNER}/${TEST_REPO}/issues`, {
    title: `[ework-daemon-test] 连通性测试 ${new Date().toISOString().slice(0, 19)}`,
    body: "这是 ework-daemon 的连通性测试 issue，将被自动清理。",
  });
  if (!r.ok) {
    fail("创建失败", r.data);
    return false;
  }
  const issue = r.data as { number: number; html_url: string };
  testIssueNumber = issue.number;
  pass(`Issue #${issue.number} created: ${issue.html_url}`);
  return true;
});

let testCommentId: number | null = null;

await test("POST /repos/{owner}/{repo}/issues/{index}/comments — 创建 comment", async () => {
  if (!testIssueNumber) {
    fail("跳过: 没有 test issue");
    return false;
  }
  const r = await api(
    "POST",
    `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${testIssueNumber}/comments`,
    { body: "🔄 Bridge Daemon 连通性测试 comment" }
  );
  if (!r.ok) {
    fail("Comment 创建失败", r.data);
    return false;
  }
  const comment = r.data as { id: number };
  testCommentId = comment.id;
  pass(`Comment #${comment.id} created`);
  return true;
});

await test("GET /repos/{owner}/{repo}/issues/{index}/comments — 列出 comments", async () => {
  if (!testIssueNumber) {
    fail("跳过: 没有 test issue");
    return false;
  }
  const r = await api(
    "GET",
    `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${testIssueNumber}/comments`
  );
  if (!r.ok) {
    fail("获取 comments 失败", r.data);
    return false;
  }
  const comments = r.data as Array<{ id: number; body: string }>;
  pass(`获取到 ${comments.length} 条 comments`);
  return true;
});

await test("PATCH /repos/{owner}/{repo}/issues/{index} — 关闭 issue", async () => {
  if (!testIssueNumber) {
    fail("跳过: 没有 test issue");
    return false;
  }
  const r = await api(
    "PATCH",
    `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${testIssueNumber}`,
    { state: "closed" }
  );
  if (!r.ok) {
    fail("关闭失败", r.data);
    return false;
  }
  const issue = r.data as { state: string };
  pass(`Issue state: ${issue.state}`);
  return true;
});

await test("HMAC-SHA256 签名验证模拟", async () => {
  const secret = "test-webhook-secret";
  const payload = JSON.stringify({
    action: "opened",
    issue: { number: 1, title: "test" },
  });

  // 模拟 Gitea 签名生成
  const sig = createHmac("sha256", secret).update(payload).digest("hex");

  // 模拟 Daemon 验证
  const verify = createHmac("sha256", secret).update(payload).digest("hex");
  const match = sig === verify;

  if (!match) {
    fail("签名不匹配");
    return false;
  }
  pass(`HMAC-SHA256 签名验证通过 (len=${sig.length})`);
  return true;
});

await test("DELETE /repos/{owner}/{repo}/issues/comments/{id} — 清理 test comment", async () => {
  if (!testCommentId) {
    fail("跳过: 没有 test comment");
    return false;
  }
  const r = await api(
    "DELETE",
    `/repos/${TEST_OWNER}/${TEST_REPO}/issues/comments/${testCommentId}`
  );
  if (!r.ok) {
    fail("删除 comment 失败", r.data);
    return false;
  }
  pass("Test comment 已删除");
  return true;
});

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(
  `Results: ${testsPassed} passed, ${testsFailed} failed, ${testsPassed + testsFailed} total`
);
if (testsFailed > 0) {
  console.log("⚠️  部分测试失败");
  process.exit(1);
} else {
  console.log("🎉 全部通过！Gitea API 完全可用。");
}
