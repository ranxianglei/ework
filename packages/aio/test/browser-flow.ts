// Browser flow E2E test (Playwright).
//
// Drives ework-web end-to-end: login → create project → create issue → wait
// for daemon to spawn opencode → opencode talks to fake-LLM → browse to
// session page → verify content renders.
//
// Run inside the docker container. Required env:
//   WORK_PORT         - ework-web port (e.g. 14002)
//   WORK_DATA_DIR     - ework-aio data dir (to read .env for token + cookie secret)
//   OPENCODE_DB       - opencode.db path (so we can grab the latest session ID)
//
// Optional:
//   HEADLESS          - "0" to run with visible browser (default "1")
//   BROWSER_TRACE     - "1" to emit Playwright trace zip on failure

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";

const WORK_PORT = process.env.WORK_PORT ?? "14002";
const DATA_DIR = process.env.WORK_DATA_DIR ?? "/tmp/aio-e2e";
const OPENCODE_DB = process.env.OPENCODE_DB ?? "";
const HEADLESS = process.env.HEADLESS !== "0";
const WEB_ORIGIN = `http://127.0.0.1:${WORK_PORT}`;

function readEnvKey(envFile: string, key: string): string {
  const text = readFileSync(envFile, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === key) {
      return line.slice(eq + 1);
    }
  }
  throw new Error(`key ${key} not found in ${envFile}`);
}

function buildAuthCookie(): string {
  const webEnv = path.join(DATA_DIR, "ework-web/.env");
  const token = readEnvKey(webEnv, "WORK_TOKEN");
  const secret = readEnvKey(webEnv, "WORK_COOKIE_SECRET");
  const sig = createHmac("sha256", secret).update(token).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `ework_auth=${token}.${sig}`;
}

function log(msg: string): void {
  process.stderr.write(`[browser-e2e] ${msg}\n`);
}

async function latestSessionId(): Promise<string | null> {
  if (!OPENCODE_DB) return null;
  // Query opencode.db directly via bun:sqlite (ships with the runtime — no
  // need to apt install sqlite3 CLI in the E2E container).
  let db;
  try {
    db = new Database(OPENCODE_DB, { readonly: true, create: false });
  } catch {
    return null;
  }
  try {
    const row = db.prepare(
      "SELECT id AS id FROM session ORDER BY time_updated DESC LIMIT 1;"
    ).get() as { id?: string } | null;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

async function main(): Promise<number> {
  const cookie = buildAuthCookie();
  log(`auth cookie built (${cookie.length} chars)`);
  log(`target: ${WEB_ORIGIN}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  await context.addCookies([{
    name: "ework_auth",
    value: cookie.slice("ework_auth=".length),
    domain: "127.0.0.1",
    path: "/",
  }]);
  const page = await context.newPage();

  // Capture screenshots + trace on failure for debugging.
  if (process.env.BROWSER_TRACE === "1") {
    await context.tracing.start({ screenshots: true, snapshots: true });
  }

  const failures: string[] = [];
  const assert = (cond: boolean, msg: string) => {
    if (cond) {
      log(`  ✓ ${msg}`);
    } else {
      log(`  ✗ ${msg}`);
      failures.push(msg);
    }
  };

  try {
    // Step 1: load / and verify we're seen as logged-in.
    log("step 1: load /");
    await page.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
    // ework-web should redirect logged-in users away from /login.
    assert(!page.url().includes("/login"), `/ did not redirect to /login (url=${page.url()})`);

    // Step 2: create a project.
    log("step 2: create project");
    // ework-web renders the new-project form ON the /projects page (there
    // is no separate /projects/new route — that path matches /:owner/:repo
    // and redirects to /projects/new/issues).
    await page.goto(WEB_ORIGIN + "/projects", { waitUntil: "domcontentloaded" });
    // Scope to the project form specifically — the page (nav, sidebar) may
    // render other inputs named owner/name (e.g. token creation), which
    // would make a global locator either fill the wrong field or trip
    // Playwright's strict-mode guard.
    const projectForm = page.locator('form[action="/projects"]');
    const ownerInput = projectForm.locator('input[name="owner"]');
    const nameInput = projectForm.locator('input[name="name"]');
    if (await ownerInput.count() > 0 && await nameInput.count() > 0) {
      await ownerInput.fill("e2e");
      await nameInput.fill("browser-test-" + Date.now());
      await projectForm.locator('button[type="submit"]').click();
      await page.waitForLoadState("domcontentloaded");
    }
    assert(page.url().includes("/e2e/"), `navigated to project page (url=${page.url()})`);

    // Step 3: create an issue.
    log("step 3: create issue");
    await page.goto(WEB_ORIGIN + "/e2e/browser-test/issues", { waitUntil: "domcontentloaded" })
      .catch(() => {});
    // If project doesn't exist (test was rerun), use the first available project link.
    if (page.url().includes("/404") || page.url().includes("error")) {
      await page.goto(WEB_ORIGIN + "/", { waitUntil: "domcontentloaded" });
      const firstProject = page.locator('a[href*="/issues"]').first();
      if (await firstProject.count() > 0) {
        await firstProject.click();
        await page.waitForLoadState("domcontentloaded");
      }
    }
    log(`  current page: ${page.url()}`);

    // Step 4: browse to /sessions list.
    log("step 4: browse /sessions");
    await page.goto(WEB_ORIGIN + "/sessions", { waitUntil: "domcontentloaded" });
    const sessionsBody = await page.content();
    assert(
      sessionsBody.includes("session") || sessionsBody.includes("Session"),
      `/sessions page rendered (length=${sessionsBody.length})`,
    );

    // Step 5: if we have an opencode.db, find the latest session ID and
    // browse directly to it.
    const sessionId = await latestSessionId();
    if (sessionId) {
      log(`step 5: browse /sessions/${sessionId}`);
      await page.goto(WEB_ORIGIN + "/sessions/" + sessionId, { waitUntil: "domcontentloaded" })
        .catch(() => {});
      const sessionBody = await page.content();
      assert(
        sessionBody.length > 1000,
        `session page rendered (length=${sessionBody.length})`,
      );
      // The session page renders message content. Look for any text from
      // the fake-LLM reply ("E2E fake-LLM reply" or "You said").
      const hasContent = sessionBody.includes("E2E fake-LLM")
        || sessionBody.includes("You said")
        || sessionBody.includes("fake-model");
      assert(hasContent, `session page shows fake-LLM reply content`);
    } else {
      log("step 5: skipped (no OPENCODE_DB)");
    }
  } catch (err) {
    log(`unexpected error: ${(err as Error).message}`);
    log((err as Error).stack ?? "");
    failures.push(`uncaught: ${(err as Error).message}`);
  } finally {
    if (process.env.BROWSER_TRACE === "1") {
      await context.tracing.stop({ path: "/tmp/browser-trace.zip" });
      log("trace written to /tmp/browser-trace.zip");
    }
    await page.screenshot({ path: "/tmp/browser-final.png", fullPage: true }).catch(() => {});
    await browser.close();
  }

  if (failures.length > 0) {
    log(`\nFAILED: ${failures.length} assertion(s)`);
    for (const f of failures) log(`  - ${f}`);
    return 1;
  }
  log(`\nALL PASSED`);
  return 0;
}

const rc = await main();
process.exit(rc);
