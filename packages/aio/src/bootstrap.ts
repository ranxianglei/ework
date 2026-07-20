// Bot user + PAT bootstrap via HTTP. Replaces curl with fetch().
// Idempotent: createIfMissing + tokenName lookup by label.

import { InstallError } from "./log.ts";

export interface BootstrapOptions {
  baseUrl: string;           // http://host:port (no trailing slash)
  adminUser: string;
  adminPassword: string;
  botLogin: string;
  botEmail: string;
  botPassword: string;
  botTokenName: string;
  // For tests: override fetch.
  fetchImpl?: typeof fetch;
  // Per-request timeout.
  timeoutMs?: number;
}

export interface BootstrapResult {
  botUserId: number;
  botToken: string;          // PAT minted for the bot account
  created: { user: boolean; token: boolean };
}

class HttpError extends InstallError {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(`${message} (HTTP ${status}): ${body.slice(0, 200)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseSetCookie(setCookie: string | null): string {
  if (!setCookie) return "";
  const first = setCookie.split(",")[0] ?? "";
  return first.split(";")[0] ?? "";
}

// pollWebUp: GET / until 2xx or timeout. Returns response. Throws HttpError
// only on non-recoverable HTTP errors (5xx); connection refused = retry.
export async function pollWebUp(opts: BootstrapOptions, maxAttempts = 30, delayMs = 500): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await timedFetch(fetchImpl, `${opts.baseUrl}/`, { method: "GET" }, timeoutMs);
      if (r.status < 500) return;
    } catch {
      // Network error — try again.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new InstallError(
    `ework-web did not come up at ${opts.baseUrl} after ${maxAttempts} attempts`,
  );
}

export async function loginAdmin(opts: BootstrapOptions): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const r = await timedFetch(
    fetchImpl,
    `${opts.baseUrl}/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: opts.adminUser, password: opts.adminPassword }),
    },
    timeoutMs,
  );

  if (!r.ok) {
    const body = await r.text();
    throw new HttpError(`admin login as ${opts.adminUser} failed`, r.status, body);
  }

  const cookie = parseSetCookie(r.headers.get("set-cookie"));
  if (!cookie) {
    throw new InstallError(`login response had no set-cookie header`);
  }
  return cookie;
}

export async function findUserIdByLogin(opts: BootstrapOptions, cookie: string, login: string): Promise<number | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const r = await timedFetch(
    fetchImpl,
    `${opts.baseUrl}/api/admin/users?login=${encodeURIComponent(login)}`,
    {
      method: "GET",
      headers: { Cookie: cookie },
    },
    timeoutMs,
  );

  if (!r.ok) {
    const body = await r.text();
    throw new HttpError(`list users failed`, r.status, body);
  }

  const data = await r.json();
  const users = Array.isArray(data) ? data : (data as { users?: unknown }).users;
  if (!Array.isArray(users)) return null;
  for (const u of users) {
    if (typeof u === "object" && u !== null && (u as { login?: string }).login === login) {
      const id = (u as { id?: unknown }).id;
      if (typeof id === "number") return id;
    }
  }
  return null;
}

export async function createUser(opts: BootstrapOptions, cookie: string): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const r = await timedFetch(
    fetchImpl,
    `${opts.baseUrl}/api/admin/users`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        login: opts.botLogin,
        email: opts.botEmail,
        password: opts.botPassword,
      }),
    },
    timeoutMs,
  );

  if (!r.ok) {
    const body = await r.text();
    throw new HttpError(`create bot user ${opts.botLogin} failed`, r.status, body);
  }

  const data = await r.json() as { id?: unknown };
  if (typeof data.id !== "number") {
    throw new InstallError(`create user response missing id field: ${JSON.stringify(data)}`);
  }
  return data.id;
}

export async function mintPAT(opts: BootstrapOptions, cookie: string, userId: number): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const r = await timedFetch(
    fetchImpl,
    `${opts.baseUrl}/api/admin/users/${userId}/tokens`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: opts.botTokenName }),
    },
    timeoutMs,
  );

  if (!r.ok) {
    const body = await r.text();
    throw new HttpError(`mint PAT for user ${userId} failed`, r.status, body);
  }

  const data = await r.json() as { token?: unknown; sha1?: unknown; value?: unknown };
  const token = data.token ?? data.sha1 ?? data.value;
  if (typeof token !== "string") {
    throw new InstallError(`mint PAT response missing token field: ${JSON.stringify(data)}`);
  }
  return token;
}

export async function listUserTokens(opts: BootstrapOptions, cookie: string, userId: number): Promise<Array<{ id: number; name: string }>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const r = await timedFetch(
    fetchImpl,
    `${opts.baseUrl}/api/admin/users/${userId}/tokens`,
    { method: "GET", headers: { Cookie: cookie } },
    timeoutMs,
  );

  if (!r.ok) {
    const body = await r.text();
    throw new HttpError(`list tokens for user ${userId} failed`, r.status, body);
  }

  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.filter((t): t is { id: number; name: string } =>
    typeof t === "object" && t !== null &&
    typeof (t as { id?: unknown }).id === "number" &&
    typeof (t as { name?: unknown }).name === "string"
  );
}

export async function bootstrapBot(opts: BootstrapOptions): Promise<BootstrapResult> {
  const cookie = await loginAdmin(opts);

  const existing = await findUserIdByLogin(opts, cookie, opts.botLogin);
  let userId: number;
  let createdUser = false;

  if (existing !== null) {
    userId = existing;
  } else {
    userId = await createUser(opts, cookie);
    createdUser = true;
  }

  const tokens = await listUserTokens(opts, cookie, userId);
  const existingToken = tokens.find((t) => t.name === opts.botTokenName);
  if (existingToken) {
    return {
      botUserId: userId,
      botToken: "",  // caller knows name is registered; mintPAT only returns clear-text on creation
      created: { user: createdUser, token: false },
    };
  }

  const token = await mintPAT(opts, cookie, userId);
  return {
    botUserId: userId,
    botToken: token,
    created: { user: createdUser, token: true },
  };
}
