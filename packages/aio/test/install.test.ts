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

// /admin/users/create returns 303 on first create, 409 on second.
function adminCreateHandler(state: MockState): (req: Request) => Promise<Response> {
  let created = false;
  return async (req) => {
    const body = await req.text();
    const params = new URLSearchParams(body);
    const login = params.get("login");
    created = true;
    void state; void login;
    return new Response(null, { status: 303, headers: { Location: "/admin/users" } });
  };
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

// /me/tokens/create returns HTML with the PAT embedded (matches install.sh).
function mintPatHandler(): (req: Request) => Promise<Response> {
  return async () => {
    const pat = "a".repeat(40);
    const html = `<!DOCTYPE html><html><body>
      <p>Your new token (shown once):</p>
      <input id="t" value="${pat}" readonly>
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
        ["POST http://127.0.0.1:3002/login", loginHandler()],
        ["POST http://127.0.0.1:3002/me/tokens/create", mintPatHandler()],
      ]),
    };
    opts = baseOpts(tmpDir);
    savedPath = { ...process.env };
    // Make `command -v ework-web` find /bin/true via a stub script.
    const stubDir = path.join(tmpDir, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });
    for (const bin of ["ework-web", "ework-daemon"]) {
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

    const result = await runInstall(opts, silentLogger(), { fetchImpl: makeMockFetch(state) });

    const webEnv = await Bun.file(path.join(tmpDir, "ework-web", ".env")).text();
    // User's WORK_PORT=9999 preserved
    expect(webEnv).toContain("WORK_PORT=9999");
    // User's comment preserved
    expect(webEnv).toContain("# My custom config");
    // User's token preserved
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
});
