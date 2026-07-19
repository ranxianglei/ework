import type { Config } from "./config";
import { getUserByLogin, ensureUser, verifyPat, type UserRow } from "./store";

// Per-user token-cookie auth. Cookie value is HMAC-signed and carries login +
// issued-at, so the server is stateless (no session table). Two cookie formats
// coexist for one release to avoid breaking existing sessions on upgrade:
//   v2 (new): "v2.<login>.<issued_unix>.<sig>" — resolves to that user
//   legacy:   "<token>.<sig>" — resolves to cfg.operatorLogin (shared-token era)

export const AUTH_COOKIE_NAME = "ework_auth";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const COOKIE_VERSION = "v2";

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Buffer.from(new Uint8Array(sig)).toString("base64url");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export interface AuthResult {
  ok: boolean;
  user: UserRow | null;
}

export function authCookieName(cfg: Config): string {
  // __Host- prefix (C2 hardening) requires Secure + Path=/ + no Domain and is only
  // honored by browsers over TLS; cfg.secureCookie is flipped on only after Caddy/TLS.
  return cfg.secureCookie ? `__Host-${AUTH_COOKIE_NAME}` : AUTH_COOKIE_NAME;
}

export async function makeAuthCookieHeader(cfg: Config, login: string): Promise<string> {
  const issued = Math.floor(Date.now() / 1000);
  const payload = `${COOKIE_VERSION}.${login}.${issued}`;
  const sig = await hmac(cfg.cookieSecret, payload);
  const value = `${payload}.${sig}`;
  const flags = ["Path=/", "HttpOnly", `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`, "SameSite=Lax"];
  if (cfg.secureCookie) flags.push("Secure");
  return `${authCookieName(cfg)}=${value}; ${flags.join("; ")}`;
}

// Logout: set Max-Age=0 so the browser drops the cookie immediately.
export function clearAuthCookieHeader(cfg: Config): string {
  const flags = ["Path=/", "HttpOnly", "Max-Age=0", "SameSite=Lax"];
  if (cfg.secureCookie) flags.push("Secure");
  return `${authCookieName(cfg)}=; ${flags.join("; ")}`;
}

function ctEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// v2 cookie parse: value is "v2.<login>.<issued>.<sig>" where login is
// guaranteed not to contain "." (enforced by LOGIN_RE in store.ts).
function parseV2Cookie(value: string): { login: string; issued: string; sig: string } | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== COOKIE_VERSION) return null;
  const [, login, issued, sig] = parts;
  if (!login || !issued || !sig) return null;
  return { login, issued, sig };
}

export async function checkAuth(req: Request, cfg: Config, ip?: string | null): Promise<AuthResult> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const cookieVal = cookies[authCookieName(cfg)];

  if (cookieVal) {
    if (cookieVal.startsWith(`${COOKIE_VERSION}.`)) {
      const parsed = parseV2Cookie(cookieVal);
      if (!parsed) return { ok: false, user: null };
      const payload = `${COOKIE_VERSION}.${parsed.login}.${parsed.issued}`;
      const expected = await hmac(cfg.cookieSecret, payload);
      if (!ctEqual(parsed.sig, expected)) return { ok: false, user: null };
      const user = getUserByLogin(parsed.login);
      if (!user || !user.is_active) return { ok: false, user: null };
      return { ok: true, user };
    }

    // Legacy format: "<token>.<sig>". Accept only if token == cfg.authToken,
    // then resolve to the configured operator user (auto-created on boot by
    // ensureBootstrapAdmin in index.ts).
    const dot = cookieVal.lastIndexOf(".");
    if (dot <= 0) return { ok: false, user: null };
    const token = cookieVal.slice(0, dot);
    const sig = cookieVal.slice(dot + 1);
    const expected = await hmac(cfg.cookieSecret, token);
    if (!ctEqual(sig, expected) || !ctEqual(token, cfg.authToken)) {
      return { ok: false, user: null };
    }
    const user = getUserByLogin(cfg.operatorLogin);
    if (!user || !user.is_active) return { ok: false, user: null };
    return { ok: true, user };
  }

  // PAT bearer (API clients / agents). Same auth surface as cookies, so any
  // route that takes a logged-in cookie also takes a Bearer PAT. Two header
  // shapes are accepted:
  //   "Bearer <token>"      — RFC 6750 / OAuth standard (also GitHub-compat)
  //   "token <token>"       — Gitea legacy form (Gitea's own client uses this)
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const lower = authHeader.toLowerCase();
    let token: string | null = null;
    if (lower.startsWith("bearer ")) {
      token = authHeader.slice(7).trim();
    } else if (lower.startsWith("token ")) {
      token = authHeader.slice(6).trim();
    }
    if (token) {
      const user = await verifyPat(token, ip);
      if (user) return { ok: true, user };
    }
  }

  return { ok: false, user: null };
}

export function ensureBootstrapAdmin(login: string): UserRow {
  const existing = getUserByLogin(login);
  if (existing) return existing;
  return ensureUser(login, "human");
}

// Reserved system user for automated actions (cron, import jobs, future CI
// integration). kind=system, no password (cannot login via UI). Created on
// boot if missing. UI guards prevent disabling/deleting it.
export function ensureBootstrapSystem(login: string): UserRow {
  const existing = getUserByLogin(login);
  if (existing) return existing;
  return ensureUser(login, "system");
}

export function isReservedSystemLogin(login: string, cfg: Config): boolean {
  return login === cfg.systemLogin;
}

// Same-origin relative targets only. Rejects "//" and "/\" — browsers collapse a
// leading "/\" to "//" (protocol-relative), an open-redirect bypass (M1).
export function sanitizeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  try {
    const u = new URL(next, "http://x.invalid");
    if (u.origin !== "http://x.invalid") return "/";
  } catch {
    return "/";
  }
  return next;
}

function esc(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function loginHTML(next: string, error?: string): string {
  const err = error ? `<div class="err">${esc(error)}</div>` : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>登录 · ework</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#1b1b1b;color:#e6e6e6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#262626;border:1px solid #373737;border-radius:12px;padding:1.8rem;max-width:360px;width:90%}
h1{font-size:18px;margin:0 0 1.2rem;font-weight:600}
label{display:block;font-size:12px;color:#9a9a9a;margin:0 0 .25rem}
input{width:100%;box-sizing:border-box;padding:.75rem;border:1px solid #373737;border-radius:8px;background:#1b1b1b;color:#e6e6e6;font:inherit;margin-bottom:.8rem}
input:focus{outline:none;border-color:#2da44e}
button{width:100%;padding:.75rem;border:none;border-radius:8px;background:#2da44e;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer}
button:hover{background:#218742}
.err{color:#f85149;font-size:13px;margin-bottom:.8rem}
.hint{color:#9a9a9a;font-size:12px;line-height:1.5;margin-top:.6rem}
.divider{display:flex;align-items:center;gap:.6rem;color:#666;font-size:12px;margin:1rem 0 .6rem}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:#373737}
.section-tag{display:inline-block;background:#373737;color:#d6d6d6;font-size:11px;padding:.15rem .55rem;border-radius:4px;margin-bottom:.4rem}
</style></head><body>
<form class="box" method="POST" action="/login" autocomplete="on">
<h1>🔒 ework 登录</h1>
${err}
<span class="section-tag">首次登录 / 管理员</span>
<label for="f-token">共享 token</label>
<input id="f-token" name="token" type="password" autocomplete="off" autofocus placeholder="WORK_TOKEN（新部署时填这个）">
<div class="hint">新部署的管理员 token 在 <code>.env</code> 文件的 <code>WORK_TOKEN</code> 里。</div>
<div class="divider">或已注册用户</div>
<label for="f-login">用户名</label>
<input id="f-login" name="login" type="text" autocomplete="username">
<label for="f-pw">密码</label>
<input id="f-pw" name="password" type="password" autocomplete="current-password">
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">登录</button>
<div class="hint">登录后 cookie 30 天有效；token 登录后可在「我的」页面给自己设密码，之后即可用户名密码登录。</div>
</form></body></html>`;
}
