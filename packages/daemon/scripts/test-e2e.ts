/**
 * E2E test: issue opened → opencode → comment back → follow-up comment → close
 *
 * Uses a mock opencode binary that returns canned NDJSON output.
 * Tests against real Gitea instance.
 *
 * Usage:
 *   GITEA_TOKEN=xxx bun run scripts/test-e2e.ts
 */
import { createHmac } from "crypto";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const GITEA_URL = process.env.GITEA_URL;
if (!GITEA_URL) {
  console.error("❌ GITEA_URL env required (point at your ework-web or real Gitea instance)");
  process.exit(1);
}
const GITEA_TOKEN = process.env.GITEA_TOKEN ?? "";
const WEBHOOK_SECRET = "test-e2e-secret";
const TEST_OWNER = "dog";
const TEST_REPO = "fast-train";
const DAEMON_PORT = 3101; // Use a different port than default to avoid conflicts

if (!GITEA_TOKEN) {
  console.error("❌ GITEA_TOKEN env required");
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────

const headers = {
  Authorization: `token ${GITEA_TOKEN}`,
  "Content-Type": "application/json",
};

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${GITEA_URL}/api/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function sign(payload: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
}

async function sendWebhook(event: string, payload: object) {
  const body = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gitea-Event": event,
      "X-Gitea-Signature": sign(body),
    },
    body,
  });
  return res;
}

function makePayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    ...overrides,
  };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  fn: () => Promise<boolean>,
  label: string,
  timeoutMs = 10000,
  intervalMs = 500
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ─── Mock opencode binary ───────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "ework-daemon-e2e-"));
mkdirSync(join(tmpDir, TEST_REPO), { recursive: true });

function createMockOpencode() {
  const script = `#!/usr/bin/env bun
const args = process.argv.slice(2);
let sessionId = "";
let prompt = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session") { sessionId = args[++i]; }
  else if (args[i] === "run" || args[i] === "--format" || args[i] === "json") { continue; }
  else { prompt = args[i]; }
}

if (!sessionId) sessionId = "ses_mock_" + Date.now() + "_" + Math.floor(Math.random() * 9999);

const lines = [
  { type: "step_start", sessionID: sessionId, part: { type: "step_start" } },
  { type: "text", sessionID: sessionId, part: { type: "text", text: "Mock response for: " + prompt } },
  { type: "step_finish", sessionID: sessionId, part: { type: "step_finish", reason: "stop" } },
];

for (const l of lines) console.log(JSON.stringify(l));
`;

  const binPath = join(tmpDir, "mock-opencode");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  return binPath;
}

// ─── Test runner ────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function assert(
  condition: boolean,
  label: string,
  detail?: string
) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ─── Main E2E test ──────────────────────────────────────────

async function main() {
  console.log("=== E2E Test: Issue → OpenCode → Comment ===\n");

  const mockBin = createMockOpencode();
  console.log(`Mock opencode: ${mockBin}`);
  console.log(`Tmp dir: ${tmpDir}\n`);

  // 1. Create a real issue on Gitea
  console.log("--- Step 1: Create test issue ---");
  const issueRes = await api("POST", `/repos/${TEST_OWNER}/${TEST_REPO}/issues`, {
    title: `[E2E Test] ework-daemon integration test ${Date.now()}`,
    body: "This is an automated E2E test. Should be auto-responded by ework-daemon.",
  });

  await assert(issueRes.ok, "Create issue via API", `status=${issueRes.status}`);
  if (!issueRes.ok) {
    console.error("Cannot create issue, aborting.");
    process.exit(1);
  }

  const issueNumber = (issueRes.data as any).number;
  const issueTitle = (issueRes.data as any).title;
  console.log(`  Issue #${issueNumber}: ${issueTitle}\n`);

  // 2. Start daemon with mock opencode
  console.log("--- Step 2: Start daemon ---");
  const env = {
    ...process.env,
    GITEA_URL,
    GITEA_TOKEN,
    GITEA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DAEMON_PORT: String(DAEMON_PORT),
    OPENCODE_BINARY: mockBin,
    OPENCODE_BASE_WORKDIR: tmpDir,
  };

  // Import and run daemon inline
  const daemonProc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for daemon to start
  await sleep(500);
  await assert(daemonProc.exitCode === null, "Daemon started and running");

  // 3. Send "issues" webhook (issue opened)
  console.log("\n--- Step 3: Send issue opened webhook ---");
  const issuePayload = makePayload("opened", {
    issue: {
      number: issueNumber,
      title: issueTitle,
      body: "This is an automated E2E test. Should be auto-responded by ework-daemon.",
      state: "open",
      html_url: `${GITEA_URL}/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}`,
      user: { login: "test-user" },
    },
    repository: {
      full_name: `${TEST_OWNER}/${TEST_REPO}`,
      owner: { login: TEST_OWNER },
      name: TEST_REPO,
    },
    sender: { login: "test-user" },
  });

  const wh1 = await sendWebhook("issues", issuePayload);
  await assert(wh1.status === 200, "Webhook accepted", `status=${wh1.status}`);

  // Wait for async handler to complete (opencode mock runs + comment posted)
  const foundResponse = await waitFor(async () => {
    const res = await api(
      "GET",
      `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}/comments`
    );
    const comments = (res.data as Array<{ body: string }>) ?? [];
    return comments.some((c) => c.body.includes("Mock response for:"));
  }, "OpenCode response");

  // 4. Verify "picked up" + response comments were posted
  console.log("\n--- Step 4: Verify comments on issue ---");
  const commentsRes = await api(
    "GET",
    `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}/comments`
  );
  await assert(commentsRes.ok, "Fetch comments via API");

  const comments = (commentsRes.data as Array<{ id: number; body: string; user: { login: string } }>);
  const pickedUpComment = comments.find((c) => c.body.includes("picked up this issue"));
  await assert(!!pickedUpComment, "Found 'picked up' comment from ework-daemon");

  const responseComment = comments.find((c) => c.body.includes("Mock response for:"));
  await assert(!!responseComment, "Found OpenCode response comment", foundResponse ? "" : "timeout waiting");
  if (responseComment) {
    console.log(`  Response preview: ${responseComment.body.slice(0, 100)}...`);
  }

  // 5. Send "issue_comment" webhook (follow-up comment)
  console.log("\n--- Step 5: Send follow-up comment webhook ---");
  const commentPayload = makePayload("created", {
    issue: {
      number: issueNumber,
      title: issueTitle,
      body: "",
      state: "open",
      html_url: `${GITEA_URL}/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}`,
      user: { login: "test-user" },
    },
    comment: {
      id: 99999,
      body: "Can you check the test results?",
      user: { login: "human" },
    },
    repository: {
      full_name: `${TEST_OWNER}/${TEST_REPO}`,
      owner: { login: TEST_OWNER },
      name: TEST_REPO,
    },
    sender: { login: "human" },
  });

  const wh2 = await sendWebhook("issue_comment", commentPayload);
  await assert(wh2.status === 200, "Comment webhook accepted", `status=${wh2.status}`);

  const foundFollowUp = await waitFor(async () => {
    const res = await api(
      "GET",
      `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}/comments`
    );
    const cs = (res.data as Array<{ body: string }>) ?? [];
    return cs.some((c) => c.body.includes("Mock response for:") && c.body.includes("[human commented]"));
  }, "Follow-up response");

  // 6. Verify follow-up response
  console.log("\n--- Step 6: Verify follow-up response ---");
  const comments2Res = await api(
    "GET",
    `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}/comments`
  );
  const comments2 = (comments2Res.data as Array<{ id: number; body: string }>);
  const followUpResponse = comments2.find(
    (c) => c.body.includes("Mock response for:") && c.body.includes("[human commented]")
  );
  await assert(!!followUpResponse, "Found follow-up response with commenter mention", foundFollowUp ? "" : "timeout");

  // 7. Close issue
  console.log("\n--- Step 7: Close test issue ---");
  await api("PATCH", `/repos/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}`, {
    state: "closed",
  });

  // Send closed webhook
  const closedPayload = makePayload("closed", {
    issue: {
      number: issueNumber,
      title: issueTitle,
      body: "",
      state: "closed",
      html_url: `${GITEA_URL}/${TEST_OWNER}/${TEST_REPO}/issues/${issueNumber}`,
      user: { login: "test-user" },
    },
    repository: {
      full_name: `${TEST_OWNER}/${TEST_REPO}`,
      owner: { login: TEST_OWNER },
      name: TEST_REPO,
    },
    sender: { login: "test-user" },
  });

  const wh3 = await sendWebhook("issues", closedPayload);
  await assert(wh3.status === 200, "Close webhook accepted");

  // Cleanup: delete test comments and issue
  console.log("\n--- Cleanup ---");
  for (const c of comments2) {
    await api("DELETE", `/repos/${TEST_OWNER}/${TEST_REPO}/issues/comments/${c.id}`);
  }
  console.log("  Cleaned up test comments");

  // Stop daemon
  daemonProc.kill();
  console.log("  Daemon stopped");

  // Remove tmp dir
  rmSync(tmpDir, { recursive: true });
  console.log("  Temp dir cleaned up");

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E test failed with error:", err);
  process.exit(1);
});
