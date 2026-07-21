// Integration tests for src/commands/install.ts runInstall().
//
// Strategy: inject mock fetch + mock filesystem-passthrough via the `hooks`
// parameter. The real ework-web / ework-daemon binaries are NOT spawned —
// we point resolveCommand at /bin/true via PATH manipulation. The real
// systemd is bypassed by useSystemd=false (default).
//
// Each test sets up a fresh tmpDir, runs runInstall, and asserts on the
// resulting files (web .env, daemon .env, bot-token, opencode.json) and
// the outcome struct.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInstall, buildAuthCookie } from "../src/commands/install.ts";
import { Logger, InstallError } from "../src/log.ts";
import { resolvePaths } from "../src/paths.ts";
import type { GlobalOptions } from "../src/types.ts";

interface MockState {
  // Captured HTTP requests, in order.
  requests: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }>;
  // What the mock server should respond with for each URL pattern.
  routes: Map<string, (req: Request) => Promise<Response>>;
}

type FetchLike = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

function makeMockFetch(state: MockState): FetchLike {
  return async (input, init) => {
    const inputStr = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const pair of h) {
          const [k, v] = pair as [string, string];
          headers[k] = String(v);
        }
      } else {
        for (const [k, v] of Object.entries(h)) headers[k] = String(v);
      }
    }
    state.requests.push({ url: inputStr, method, body, headers });
    const handler = state.routes.get(method + " " + inputStr) ?? state.routes.get(inputStr);
    if (!handler) {
      return new Response("not found", { status: 404 });
    }
    const req = new Request(inputStr, init);
    return handler(req);
  };
}

function silentLogger(): Logger {
  const sink = { write: () => true, isTTY: false };
  return new Logger({ stdout: sink, stderr: sink });
}

interface CapturingSink {
  chunks: string[];
  write(chunk: string | Uint8Array): boolean;
  isTTY: boolean;
}

function capturingSink(): CapturingSink {
  return {
    chunks: [],
    write(chunk) { this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); return true; },
    isTTY: false,
  };
}

function baseOpts(tmpDir: string): GlobalOptions {
  return {
    workPort: 3002,
    daemonPort: 3101,
    botName: "ework-daemon",
    scope: "user",
    useSystemd: false,
    assumeYes: true,
    allowRoot: false,
    noRestart: false,
    noStart: false,
    dataDir: tmpDir,
  };
}

// /admin/users/create returns 303 with ?ok=1 on success. ework-web uses
// the PRG pattern for BOTH success and failure (the latter would have
// ?err= in Location), but the default happy-path mock only needs success.
function adminCreateHandler(state: MockState): (req: Request) => Promise<Response> {
  let created = false;
  return async (req) => {
    const body = await req.text();
    const params = new URLSearchParams(body);
    const login = params.get("login");
    created = true;
    void state; void login;
    return new Response(null, { status: 303, headers: { Location: "/admin/users?ok=1" } });
  };
}

// /admin/users/<login>/reset-password returns 303 with ?ok=1 on success.
// bootstrapBot now ALWAYS calls this after create (idempotent — sets the
// password to our fresh value whether the user was just created or
// already existed). Without this default route, the happy-path install
// test would 404 here.
function resetPasswordHandler(): (req: Request) => Promise<Response> {
  return async () => new Response(null, { status: 303, headers: { Location: "/admin/users?ok=1" } });
}

// /login returns 302 with set-cookie when creds are valid.
function loginHandler(): (req: Request) => Promise<Response> {
  return async (req) => {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "set-cookie": "ework_auth=bot-session-token.signature-here; Path=/; HttpOnly",
      },
    });
  };
}

// /me/tokens/create returns HTML with the PAT embedded. Matches the
// ACTUAL ework-web response shape: <code id="t">VALUE</code> (see
// src/views/tokens.ts:141 in ework-web). Earlier versions of this mock
// used <input value="..."> which did not match production HTML — that
// false-positive hid the real scrape bug until a user hit it in v0.2.2.
function mintPatHandler(): (req: Request) => Promise<Response> {
  return async () => {
    const pat = "a".repeat(40);
    const html = `<!DOCTYPE html><html><body>
      <h1>Token 已创建</h1>
      <div class="tok-box"><code id="t">${pat}</code><button>复制</button></div>
      </body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  };
}

// Legacy HTML shape: <input value="..." id="t"> (attribute order swapped).
// Keeps the second regex in bootstrapBot exercised so it doesn't rot.
function mintPatHandlerReverseAttrs(): (req: Request) => Promise<Response> {
  return async () => {
    const pat = "b".repeat(40);
    const html = `<!DOCTYPE html><html><body>
      <p>Your new token (shown once):</p>
      <input value="${pat}" id="t" readonly>
      </body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  };
}

// Case-insensitive PAT scrape: ework-web template tweaks (XHTML uppercase,
// mixed-case templating) must not silently break scraping. The regex's `i`
// flag accepts <INPUT VALUE="..." ID="t"> in addition to lowercase.
function mintPatHandlerUppercase(): (req: Request) => Promise<Response> {
  return async () => {
    const pat = "c".repeat(40);
    const html = `<!DOCTYPE html><html><body>
      <INPUT ID="t" VALUE="${pat}" READONLY>
      </body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  };
}

describe("buildAuthCookie", () => {
  test("produces ework_auth=<token>.<base64url hmac>", () => {
    const token = "abc123";
    const secret = "super-secret-key";
    const cookie = buildAuthCookie(token, secret);
    expect(cookie.startsWith("ework_auth=abc123.")).toBe(true);
    // The signature should be base64url-encoded (no +, /, =).
    const sig = cookie.split(".")[1]!;
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("same inputs produce same signature (deterministic)", () => {
    const a = buildAuthCookie("x", "y");
    const b = buildAuthCookie("x", "y");
    expect(a).toBe(b);
  });

  test("different secrets produce different signatures", () => {
    const a = buildAuthCookie("x", "s1");
    const b = buildAuthCookie("x", "s2");
    expect(a).not.toBe(b);
  });
});

describe("runInstall: end-to-end (mocked fetch, real FS)", () => {
  let tmpDir: string;
  let state: MockState;
  let opts: GlobalOptions;
  let savedPath: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-test-"));
    state = {
      requests: [],
      routes: new Map([
        ["GET http://127.0.0.1:3002/login", async () => new Response("ok", { status: 200 })],
        ["POST http://127.0.0.1:3002/admin/users/create", adminCreateHandler(state)],
        ["POST http://127.0.0.1:3002/admin/users/ework-daemon/reset-password", resetPasswordHandler()],
        ["POST http://127.0.0.1:3002/login", loginHandler()],
        ["POST http://127.0.0.1:3002/me/tokens/create", mintPatHandler()],
      ]),
    };
    opts = baseOpts(tmpDir);
    savedPath = { ...process.env };
    // Make `command -v ework-web` find /bin/true via a stub script.
    const stubDir = path.join(tmpDir, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });
    for (const bin of ["ework-web", "ework-daemon", "ework-daemon-server"]) {
      const stub = path.join(stubDir, bin);
      fs.writeFileSync(stub, `#!/bin/sh\nsleep 60\n`, { mode: 0o755 });
    }
    process.env.PATH = `${stubDir}:${process.env.PATH}`;
    // HOME isolation so opencode.json lands in tmpDir.
    process.env.HOME = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, ".config");
    process.env.XDG_DATA_HOME = path.join(tmpDir, ".local", "share");
  });

  afterEach(() => {
    process.env = savedPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("first install: creates all data dirs, writes both .env, bootstraps bot, registers plugin", async () => {
    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });

    // 1. Data dirs
    expect(fs.existsSync(path.join(tmpDir, "ework-web"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "ework-daemon"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "run"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "opencode-workdir"))).toBe(true);

    // 2. .env files exist with required keys
    const webEnv = await Bun.file(path.join(tmpDir, "ework-web", ".env")).text();
    expect(webEnv).toContain("WORK_PORT=3002");
    expect(webEnv).toContain("WORK_TOKEN=");
    expect(webEnv).toContain("WORK_COOKIE_SECRET=");
    expect(webEnv).toContain("WORK_OPERATOR_LOGIN=");

    const daemonEnv = await Bun.file(path.join(tmpDir, "ework-daemon", ".env")).text();
    expect(daemonEnv).toContain("DAEMON_PORT=3101");
    expect(daemonEnv).toContain("GITEA_URL=http://127.0.0.1:3002");
    expect(daemonEnv).toContain("BOT_USERNAME=ework-daemon");

    // 3. Bot bootstrap happened
    expect(result.botBootstrapped).toBe(true);
    expect(result.botToken).toMatch(/^[a-f0-9]{40}$/);

    // bot-token file written
    const savedToken = await Bun.file(path.join(tmpDir, "bot-token")).text();
    expect(savedToken).toBe(result.botToken);

    // BOT_TOKEN + GITEA_TOKEN patched into daemon .env
    expect(daemonEnv).toContain(`BOT_TOKEN=${result.botToken}`);
    expect(daemonEnv).toContain(`GITEA_TOKEN=${result.botToken}`);

    // 4. opencode.json has the plugin
    const occ = await Bun.file(path.join(tmpDir, ".config", "opencode", "opencode.json")).text();
    expect(occ).toContain("opencode-ework@latest");

    // 5. HTTP traffic: poll /login, then create user, login as bot, mint PAT
    const methods = state.requests.map((r) => `${r.method} ${r.url}`).join("\n");
    expect(methods).toContain("GET http://127.0.0.1:3002/login");
    expect(methods).toContain("POST http://127.0.0.1:3002/admin/users/create");
    expect(methods).toContain("POST http://127.0.0.1:3002/login");
    expect(methods).toContain("POST http://127.0.0.1:3002/me/tokens/create");

    // 6. Services started in PID-file mode (stubs stay alive via sleep 60)
    expect(result.webStarted).toBe(true);
    expect(result.daemonStarted).toBe(true);

    // Cleanup: kill the stub processes.
    const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
    const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
    try { process.kill(webPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
  });

  // Regression: v0.2.4 and earlier spawned the `ework-daemon` client CLI instead
  // of `ework-daemon-server`, so the daemon "died" instantly with a help-text
  // log. The installer must reject an environment where the server bin is
  // missing even if the client CLI is present, otherwise users get the same
  // silent-failure mode.
  test("preflight rejects when ework-daemon-server is missing but ework-daemon client is present", async () => {
    fs.unlinkSync(path.join(tmpDir, "stubs", "ework-daemon-server"));

    await expect(runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/ework-daemon-server binary not found on PATH/);
  });

  test("second run (idempotent): reuses saved bot token, doesn't re-mint", async () => {
    const fetchImpl = makeMockFetch(state);

    // Pre-populate bot-token file.
    const preToken = "b".repeat(40);
    await fs.promises.writeFile(path.join(tmpDir, "bot-token"), preToken, { mode: 0o600 });

    const result = await runInstall(opts, silentLogger(), { fetchImpl });

    expect(result.botBootstrapped).toBe(true);
    expect(result.botToken).toBe(preToken);

    // Should NOT have hit create-user / login / mint-PAT endpoints.
    const methods = state.requests.map((r) => `${r.method} ${r.url}`).join("\n");
    expect(methods).not.toContain("POST http://127.0.0.1:3002/admin/users/create");
    expect(methods).not.toContain("POST http://127.0.0.1:3002/login");

    // Cleanup
    const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
    const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
    try { process.kill(webPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
  });

  test("forward-fill preserves user .env edits", async () => {
    // Pre-write a web .env with a custom WORK_PORT.
    await fs.promises.mkdir(path.join(tmpDir, "ework-web"), { recursive: true });
    const customEnv = `# My custom config
WORK_PORT=9999
WORK_HOST=0.0.0.0
WORK_TOKEN=mycustomtoken
WORK_COOKIE_SECRET=mycustomsecret
WORK_OPERATOR_LOGIN=alice
WORK_WRITES_ENABLED=true
WORK_DB_PATH=/tmp/x.db
WORK_ATTACHMENT_ROOT=/tmp/att
WORK_FILE_ROOTS=/tmp
WORK_DAEMON_BOT_LOGIN=ework-daemon
WORK_DAEMON_WEBHOOK_URL=http://127.0.0.1:3101
WORK_DAEMON_WEBHOOK_SECRET=somesecret
`;
    await fs.promises.writeFile(path.join(tmpDir, "ework-web", ".env"), customEnv, { mode: 0o600 });

    // S-3: install now polls the actual WORK_PORT from .env (9999), not
    // opts.workPort. Re-register the mock routes on port 9999 so the
    // poll-then-bootstrap flow can complete.
    state.routes.set("GET http://127.0.0.1:9999/login", async () => new Response("ok", { status: 200 }));
    state.routes.set("POST http://127.0.0.1:9999/admin/users/create", adminCreateHandler(state));
    state.routes.set("POST http://127.0.0.1:9999/admin/users/ework-daemon/reset-password", resetPasswordHandler());
    state.routes.set("POST http://127.0.0.1:9999/login", loginHandler());
    state.routes.set("POST http://127.0.0.1:9999/me/tokens/create", mintPatHandler());

    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });

    const webEnv = await Bun.file(path.join(tmpDir, "ework-web", ".env")).text();
    expect(webEnv).toContain("WORK_PORT=9999");
    expect(webEnv).toContain("# My custom config");
    expect(webEnv).toContain("WORK_TOKEN=mycustomtoken");

    // Cleanup
    const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
    const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
    try { process.kill(webPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
    void result;
  });

  test("missing opencode binary → InstallError", async () => {
    // Hide opencode by stripping PATH.
    process.env.PATH = "/nonexistent";
    await expect(runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/Missing required commands/);
  });

  test("missing ework-web binary → InstallError with install hint", async () => {
    // Keep bun/npm/opencode on PATH (so preflight passes) but drop the
    // stub dir so resolveCommand("ework-web") returns null.
    process.env.PATH = `/home/dog/.local/bin:/usr/local/bin:/usr/bin:/bin`;
    await expect(runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/ework-web binary not found/);
  });

  test("bootstrap failure: create-user returns 5xx → InstallError (B-5)", async () => {
    // Override /admin/users/create to return 500.
    state.routes.set("POST http://127.0.0.1:3002/admin/users/create", async () => {
      return new Response("internal error", { status: 500 });
    });
    await expect(runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/install completed with degraded state/);

    // Cleanup
    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  test("bootstrap failure: PAT regex misses → InstallError (B-5)", async () => {
    // /me/tokens/create returns HTML WITHOUT the expected <input id="t">.
    state.routes.set("POST http://127.0.0.1:3002/me/tokens/create", async () => {
      return new Response("<html>no token input here</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    });
    await expect(runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/install completed with degraded state/);

    // Cleanup
    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  test("--no-start skips service startup entirely (B-3)", async () => {
    const noStartOpts = { ...opts, noStart: true };
    const result = await runInstall(noStartOpts, silentLogger(), { fetchImpl: makeMockFetch(state) });

    expect(result.webStarted).toBe(false);
    expect(result.daemonStarted).toBe(false);
    expect(result.botBootstrapped).toBe(false);
    expect(result.botToken).toBe("");

    // .env files are still written.
    expect(await Bun.file(path.join(tmpDir, "ework-web", ".env")).text()).toContain("WORK_PORT=3002");
    expect(await Bun.file(path.join(tmpDir, "ework-daemon", ".env")).text()).toContain("DAEMON_PORT=3101");

    // No PID files (services weren't started).
    expect(fs.existsSync(path.join(tmpDir, "run", "web.pid"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "run", "daemon.pid"))).toBe(false);
  });

  test("--bot-name other-bot uses a separate token file (B-6)", async () => {
    const opts2 = { ...opts, botName: "other-bot" };
    // bootstrapBot always calls reset-password at /admin/users/<botName>/reset-password.
    // The default mock route is keyed to "ework-daemon"; register one for the
    // alternative bot name so the install completes end-to-end.
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/other-bot/reset-password",
      resetPasswordHandler(),
    );
    const result = await runInstall(opts2, silentLogger(), { fetchImpl: makeMockFetch(state) });

    expect(result.botName).toBe("other-bot");
    // bot-token file for non-default name should include the name suffix.
    expect(fs.existsSync(path.join(tmpDir, "bot-token.other-bot"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "bot-token"))).toBe(false);

    // Cleanup
    const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
    const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
    try { process.kill(webPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
  });

  test("PAT scrape matches HTML with reversed attribute order (G11)", async () => {
    // Override /me/tokens/create to return HTML where value= comes before id=.
    // bootstrapBot's second regex must match this; deleting it fails this test.
    state.routes.set(
      "POST http://127.0.0.1:3002/me/tokens/create",
      mintPatHandlerReverseAttrs(),
    );
    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });
    expect(result.botBootstrapped).toBe(true);
    expect(result.botToken).toMatch(/^[a-f0-9]{40}$/);

    const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
    const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
    try { process.kill(webPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
  });

  // Real-world regression: ework-web's actual /me/tokens/create response is
  // a verbose multi-line HTML page with warning banner, copy button, and
  // the token inside <code id="t">VALUE</code>. v0.2.0-v0.2.2 scraped only
  // <input value="..."> and failed on this shape — user hit it in production.
  // Test mirrors the real HTML byte-for-byte from src/views/tokens.ts:116-145.
  test("PAT scrape matches ework-web's actual <code id=\"t\"> HTML shape (v0.2.2 user regression)", async () => {
    const pat = "c".repeat(40);
    state.routes.set(
      "POST http://127.0.0.1:3002/me/tokens/create",
      async () => new Response(
        `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>Token 已创建 · ework-daemon</title>
<style>.tok-box{display:flex;gap:.5rem}</style></head><body>
<header class="topbar"><span style="font-weight:600">🔑 Token 已创建</span></header>
<main class="wrap">
<h1>aio-1700000000000</h1>
<div class="card">
<div class="warn">⚠️ 这是 token 的明文，<b>仅显示这一次</b>。关闭此页后无法再次查看。请立即复制到密码管理器或 agent 配置中。</div>
<h2>token</h2>
<div class="tok-box"><code id="t">${pat}</code><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('t').innerText).then(()=>{this.textContent='已复制 ✓';setTimeout(()=>this.textContent='复制',1500)})">复制</button></div>
<div class="hint">用法：HTTP 请求加 <code>Authorization: Bearer &lt;token&gt;</code>。</div>
</div>
</main></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      ),
    );
    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });
    expect(result.botBootstrapped).toBe(true);
    expect(result.botToken).toBe(pat);

    const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
    const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
    try { process.kill(webPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
  });

  test("PAT endpoint returning 303 (PRG) is NOT auto-followed (G12 redirect:manual)", async () => {
    // If redirect:"manual" is removed, fetch auto-follows the 303 → GET
    // lands on /me/tokens → 200 with no PAT input → bootstrap fails with
    // "could not extract PAT". With redirect:"manual" in place, install
    // sees the 303 directly, fails with "mint PAT returned HTTP 303", and
    // **never calls** GET /me/tokens. We assert on the request log so the
    // test catches the regression even though both paths throw the same
    // "install completed with degraded state" wrapper downstream.
    state.routes.set(
      "POST http://127.0.0.1:3002/me/tokens/create",
      async () => new Response(null, { status: 303, headers: { Location: "/me/tokens" } }),
    );
    state.routes.set(
      "GET http://127.0.0.1:3002/me/tokens",
      async () => new Response("<html>token list, no clear-text here</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    await expect(runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/install completed with degraded state/);

    // The defining assertion: GET /me/tokens must NOT appear in the request
    // log. If it does, fetch auto-followed the 303 — meaning redirect:"manual"
    // was removed.
    const autoFollowed = state.requests.some(
      (r) => r.method === "GET" && r.url === "http://127.0.0.1:3002/me/tokens",
    );
    expect(autoFollowed).toBe(false);

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // G13: login returning 200 (no redirect) without set-cookie means the
  // credentials were wrong OR ework-web changed its login flow. bootstrapBot
  // has two guard branches that must throw typed errors (not crash on null
  // deref or silently continue with botCookie=""):
  //   - status !== 302 → "bot login failed (HTTP <status>)"
  //   - status === 302 but no set-cookie → "missing ework_auth cookie"
  // Both are wrapped by B-5's "degraded state" InstallError; we assert on
  // the wrapper and inspect captured stderr for the underlying message.
  test("login 200 without set-cookie → InstallError (G13, status-check branch)", async () => {
    const stderrChunks: string[] = [];
    const stderrStream = {
      write(chunk: string | Uint8Array): boolean {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      },
      isTTY: false,
    };
    const captured = new Logger({ stdout: stderrStream, stderr: stderrStream });
    state.routes.set(
      "POST http://127.0.0.1:3002/login",
      async () => new Response("<html>bad credentials</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    await expect(runInstall(opts, captured, { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/install completed with degraded state/);
    expect(stderrChunks.join("")).toMatch(/bot login failed \(HTTP 200\)/);

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  test("login 302 without set-cookie → InstallError (G13, cookie-missing branch)", async () => {
    const stderrChunks: string[] = [];
    const stderrStream = {
      write(chunk: string | Uint8Array): boolean {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      },
      isTTY: false,
    };
    const captured = new Logger({ stdout: stderrStream, stderr: stderrStream });
    // 302 with Location but no set-cookie — login appears to succeed but
    // no session cookie was issued. parseFirstCookie must return null and
    // bootstrapBot must throw naming the missing cookie.
    state.routes.set(
      "POST http://127.0.0.1:3002/login",
      async () => new Response(null, { status: 302, headers: { Location: "/" } }),
    );
    await expect(runInstall(opts, captured, { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/install completed with degraded state/);
    expect(stderrChunks.join("")).toMatch(/missing ework_auth cookie/);

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // G15: bot create returns 400 (already exists) on re-run. This is the
  // re-run bootstrap path — install must NOT treat it as failure, must
  // proceed to login + mint PAT. Without this test, a regression that
  // throws on 400 would make every re-install fail.
  // G15: bot create returning 400 (already exists) on re-run. The ework-web
  // reality is that create ALWAYS returns 303 (PRG pattern) with ?err=
  // "已存在" in Location. bootstrapBot must NOT abort on this error — it
  // must proceed to call reset-password (which is the actual recovery).
  test("bot create returning 'already exists' error is recovered by reset-password (G15)", async () => {
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/create",
      async () => new Response(null, {
        status: 303,
        headers: { Location: `/admin/users?err=${encodeURIComponent("用户 ework-daemon 已存在")}` },
      }),
    );
    let resetCalled = false;
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/ework-daemon/reset-password",
      async () => {
        resetCalled = true;
        return new Response(null, { status: 303, headers: { Location: "/admin/users?ok=1" } });
      },
    );
    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });
    expect(result.botBootstrapped).toBe(true);
    expect(resetCalled).toBe(true);

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // Real-world regression: bot user pre-existing from a prior failed
  // install. bootstrapBot's create returns 303 with ?err=已存在, the
  // reset-password call sets the password to our fresh value, login
  // succeeds. This is the exact scenario the user hit on their machine
  // after the first install attempt failed mid-bootstrap.
  test("bot user pre-existing (Location has ?err=已存在) → reset-password recovers, bootstrap succeeds", async () => {
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/create",
      async () => new Response(null, {
        status: 303,
        headers: { Location: `/admin/users?err=${encodeURIComponent("用户 ework-daemon 已存在")}` },
      }),
    );
    let resetCalled = false;
    let resetBody: string | undefined;
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/ework-daemon/reset-password",
      async (req) => {
        resetCalled = true;
        resetBody = await req.text();
        return new Response(null, { status: 303, headers: { Location: "/admin/users?ok=1" } });
      },
    );

    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });
    expect(result.botBootstrapped).toBe(true);
    expect(result.botToken).toMatch(/^[a-f0-9]{40}$/);
    expect(resetCalled).toBe(true);
    // Reset body must contain a 48-char hex password (randomBytes(24).hex).
    const resetParams = new URLSearchParams(resetBody ?? "");
    expect(resetParams.get("password")?.length).toBe(48);

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // If create returns 303 with a non-"already exists" error (e.g. invalid
  // bot login), bootstrap must abort with a clear message — NOT proceed
  // to reset-password (which would likely fail the same way).
  test("create returning non-duplicate error → InstallError (no reset attempted)", async () => {
    let resetCalled = false;
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/create",
      async () => new Response(null, {
        status: 303,
        headers: { Location: `/admin/users?err=${encodeURIComponent("login 含非法字符")}` },
      }),
    );
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/ework-daemon/reset-password",
      async () => { resetCalled = true; return new Response(null, { status: 303 }); },
    );

    // runInstall wraps bootstrap failures as "install completed with degraded
    // state" (B-5). The underlying error is logged via logger.error — capture
    // stderr to verify the specific message is surfaced to the user.
    const sink = capturingSink();
    const cap = new Logger({ stdout: sink, stderr: sink });
    await expect(runInstall(opts, cap, { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/install completed with degraded state/);
    expect(resetCalled).toBe(false);
    const logged = sink.chunks.join("");
    expect(logged).toContain("bot bootstrap failed");
    expect(logged).toContain("login 含非法字符");

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // If reset-password itself fails (e.g. user somehow doesn't exist, or
  // password policy rejected our value), bootstrap must throw a typed
  // InstallError — NOT fall through to login with a password that won't work.
  test("reset-password failure surfaces as InstallError (not silent login 401)", async () => {
    state.routes.set(
      "POST http://127.0.0.1:3002/admin/users/ework-daemon/reset-password",
      async () => new Response(null, {
        status: 303,
        headers: { Location: `/admin/users?err=${encodeURIComponent("用户 ework-daemon 不存在")}` },
      }),
    );

    const sink = capturingSink();
    const cap = new Logger({ stdout: sink, stderr: sink });
    await expect(runInstall(opts, cap, { fetchImpl: makeMockFetch(state) }))
      .rejects.toThrow(/install completed with degraded state/);
    const logged = sink.chunks.join("");
    expect(logged).toContain("bot bootstrap failed");
    expect(logged).toContain("ework-daemon 不存在");

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  test("PAT scrape matches uppercase XHTML <INPUT VALUE=... ID=...> (case-insensitive regex)", async () => {
    // ework-web template might emit uppercase tag/attr names (XHTML style,
    // server-side template quirks). Without the regex `i` flag this returns
    // "could not extract PAT" and install fails.
    state.routes.set(
      "POST http://127.0.0.1:3002/me/tokens/create",
      mintPatHandlerUppercase(),
    );
    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });
    expect(result.botBootstrapped).toBe(true);
    expect(result.botToken).toBe("c".repeat(40));

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // Regression: pre-v0.2.6 the installer generated two INDEPENDENT hex(20)
  // values for the webhook secret on each side, so every incoming webhook
  // failed HMAC verification with "invalid signature". Both sides must end
  // up with the same value after install.
  test("webhook secret is identical across web and daemon .env after first install", async () => {
    await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });

    const webEnv = await Bun.file(path.join(tmpDir, "ework-web", ".env")).text();
    const daemonEnv = await Bun.file(path.join(tmpDir, "ework-daemon", ".env")).text();
    const webMatch = webEnv.match(/^WORK_DAEMON_WEBHOOK_SECRET=(.+)$/m);
    const daemonMatch = daemonEnv.match(/^GITEA_WEBHOOK_SECRET=(.+)$/m);
    expect(webMatch).not.toBeNull();
    expect(daemonMatch).not.toBeNull();
    expect(webMatch![1]).toBe(daemonMatch![1]);
    expect(webMatch![1]!.length).toBeGreaterThanOrEqual(32);

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // Regression: the v0.2.6 shared-secret closure only helps first install.
  // A user with a broken pre-v0.2.6 install (two different secrets) re-runs
  // install — forward-fill preserves both, so the bug persists unless the
  // reconcile step explicitly overwrites the daemon side from the web side.
  test("reconcile step overwrites mismatched daemon GITEA_WEBHOOK_SECRET from web side on re-install", async () => {
    // Simulate a broken pre-v0.2.6 install: write both .env files ahead of
    // time with intentionally different secrets. ensureEnvFile must NOT
    // overwrite the user-set value (forward-fill principle).
    await fs.promises.mkdir(path.join(tmpDir, "ework-web"), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, "ework-daemon"), { recursive: true });
    await Bun.write(
      path.join(tmpDir, "ework-web", ".env"),
      "WORK_DAEMON_WEBHOOK_SECRET=webbestsecret1234567890\n",
    );
    await Bun.write(
      path.join(tmpDir, "ework-daemon", ".env"),
      "GITEA_WEBHOOK_SECRET=daemonbadsecret9999999999\n",
    );

    await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });

    const daemonEnv = await Bun.file(path.join(tmpDir, "ework-daemon", ".env")).text();
    expect(daemonEnv).toContain("GITEA_WEBHOOK_SECRET=webbestsecret1234567890");
    expect(daemonEnv).not.toContain("daemonbadsecret");

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });

  // Regression: pre-v0.2.6 ework-web fell back to /tmp/ework-access.log when
  // WORK_ACCESS_LOG was unset, which on shared boxes is owned by another
  // user → EACCES on every request. The installer must always set this to a
  // path under the user-owned data dir.
  test("WORK_ACCESS_LOG is set under data dir, not left to /tmp default", async () => {
    await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });

    const webEnv = await Bun.file(path.join(tmpDir, "ework-web", ".env")).text();
    expect(webEnv).toContain(`WORK_ACCESS_LOG=${tmpDir}/run/web-access.log`);
    // The bug was ework-web defaulting to a bare /tmp/ework-access.log when
    // WORK_ACCESS_LOG was unset. Catch exactly that default — not any /tmp
    // path (test tmpDir itself is under /tmp).
    expect(webEnv).not.toMatch(/WORK_ACCESS_LOG=\/tmp\/ework-access\.log/);

    try {
      const webPid = parseInt(await Bun.file(path.join(tmpDir, "run", "web.pid")).text(), 10);
      process.kill(webPid, "SIGKILL");
    } catch { /* already gone */ }
    try {
      const daemonPid = parseInt(await Bun.file(path.join(tmpDir, "run", "daemon.pid")).text(), 10);
      process.kill(daemonPid, "SIGKILL");
    } catch { /* already gone */ }
  });
});
