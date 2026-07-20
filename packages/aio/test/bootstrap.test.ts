import { describe, expect, it, mock, beforeEach } from "bun:test";

import {
  pollWebUp,
  loginAdmin,
  findUserIdByLogin,
  createUser,
  mintPAT,
  listUserTokens,
  bootstrapBot,
  type BootstrapOptions,
} from "../src/bootstrap.ts";

const baseOpts: BootstrapOptions = {
  baseUrl: "http://127.0.0.1:3002",
  adminUser: "admin",
  adminPassword: "secret",
  botLogin: "ework-bot",
  botEmail: "bot@example.com",
  botPassword: "botpass",
  botTokenName: "ework-daemon",
};

function makeResponse(init: { status?: number; headers?: Record<string, string>; body?: unknown }): Response {
  const bodyStr = init.body !== undefined ? JSON.stringify(init.body) : "";
  return new Response(bodyStr, {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("pollWebUp", () => {
  it("returns when server responds 2xx", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({ status: 200, body: { ok: true } })));
    await pollWebUp({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch }, 3, 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on connection refused (network error)", async () => {
    let calls = 0;
    const fetchMock = mock(() => {
      calls++;
      if (calls < 3) throw new TypeError("connection refused");
      return Promise.resolve(makeResponse({ status: 200, body: {} }));
    });
    await pollWebUp({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch }, 5, 10);
    expect(calls).toBe(3);
  });

  it("throws InstallError after maxAttempts", async () => {
    const fetchMock = mock(() => Promise.reject(new TypeError("nope")));
    expect(async () => {
      await pollWebUp({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch }, 2, 10);
    }).toThrow();
  });
});

describe("loginAdmin", () => {
  it("extracts cookie from set-cookie header", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("{}", {
      status: 200,
      headers: { "set-cookie": "session=abc123; Path=/; HttpOnly" },
    })));
    const cookie = await loginAdmin({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(cookie).toBe("session=abc123");
  });

  it("throws HttpError on 401", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({ status: 401, body: { error: "bad creds" } })));
    expect(async () => {
      await loginAdmin({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch });
    }).toThrow(/admin login as admin failed/);
  });

  it("throws InstallError when set-cookie missing", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    expect(async () => {
      await loginAdmin({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch });
    }).toThrow(/no set-cookie/);
  });
});

describe("findUserIdByLogin", () => {
  it("returns userId when login matches", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({
      status: 200,
      body: [{ id: 7, login: "ework-bot" }, { id: 1, login: "admin" }],
    })));
    const id = await findUserIdByLogin(
      { ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch },
      "cookie",
      "ework-bot",
    );
    expect(id).toBe(7);
  });

  it("returns null when no user matches", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({
      status: 200,
      body: [{ id: 1, login: "admin" }],
    })));
    const id = await findUserIdByLogin(
      { ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch },
      "cookie",
      "ework-bot",
    );
    expect(id).toBeNull();
  });
});

describe("createUser + mintPAT", () => {
  it("creates user, returns id", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({
      status: 201,
      body: { id: 42, login: "ework-bot" },
    })));
    const id = await createUser(
      { ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch },
      "cookie",
    );
    expect(id).toBe(42);
  });

  it("throws HttpError on create failure", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({
      status: 400,
      body: { error: "login taken" },
    })));
    expect(async () => {
      await createUser({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch }, "cookie");
    }).toThrow(/create bot user.*failed/);
  });

  it("mints PAT and returns token string", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({
      status: 201,
      body: { token: "tok_abcdef", name: "ework-daemon" },
    })));
    const token = await mintPAT(
      { ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch },
      "cookie",
      42,
    );
    expect(token).toBe("tok_abcdef");
  });

  it("throws on token response missing token field", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({
      status: 201,
      body: { name: "ework-daemon" },
    })));
    expect(async () => {
      await mintPAT({ ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch }, "cookie", 42);
    }).toThrow(/missing token field/);
  });
});

describe("listUserTokens", () => {
  it("filters out malformed entries", async () => {
    const fetchMock = mock(() => Promise.resolve(makeResponse({
      status: 200,
      body: [
        { id: 1, name: "ework-daemon" },
        { id: "broken" },
        { no_name: true },
        null,
      ],
    })));
    const tokens = await listUserTokens(
      { ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch },
      "cookie",
      42,
    );
    expect(tokens).toEqual([{ id: 1, name: "ework-daemon" }]);
  });
});

describe("bootstrapBot (end-to-end)", () => {
  function bootstrapFetchScenario(scenario: {
    userExists?: boolean;
    tokenExists?: boolean;
  }) {
    return mock((url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";

      if (u.endsWith("/login") && method === "POST") {
        return Promise.resolve(new Response("{}", {
          status: 200,
          headers: { "set-cookie": "session=abc; Path=/" },
        }));
      }
      if (u.includes("/api/admin/users?login=ework-bot")) {
        return Promise.resolve(makeResponse({
          status: 200,
          body: scenario.userExists ? [{ id: 5, login: "ework-bot" }] : [],
        }));
      }
      if (u.endsWith("/api/admin/users") && method === "POST") {
        if (scenario.userExists) {
          return Promise.resolve(makeResponse({ status: 400, body: { error: "exists" } }));
        }
        return Promise.resolve(makeResponse({ status: 201, body: { id: 5, login: "ework-bot" } }));
      }
      if (u.match(/\/api\/admin\/users\/\d+\/tokens$/) && method === "GET") {
        return Promise.resolve(makeResponse({
          status: 200,
          body: scenario.tokenExists ? [{ id: 1, name: "ework-daemon" }] : [],
        }));
      }
      if (u.match(/\/api\/admin\/users\/\d+\/tokens$/) && method === "POST") {
        if (scenario.tokenExists) {
          return Promise.resolve(makeResponse({ status: 400, body: { error: "exists" } }));
        }
        return Promise.resolve(makeResponse({ status: 201, body: { token: "tok_xyz" } }));
      }
      return Promise.resolve(makeResponse({ status: 404, body: { error: "no route" } }));
    });
  }

  it("creates user + mints token on fresh install", async () => {
    const f = bootstrapFetchScenario({ userExists: false, tokenExists: false });
    const result = await bootstrapBot({ ...baseOpts, fetchImpl: f as unknown as typeof fetch });
    expect(result.botUserId).toBe(5);
    expect(result.botToken).toBe("tok_xyz");
    expect(result.created).toEqual({ user: true, token: true });
  });

  it("reuses existing user, creates token", async () => {
    const f = bootstrapFetchScenario({ userExists: true, tokenExists: false });
    const result = await bootstrapBot({ ...baseOpts, fetchImpl: f as unknown as typeof fetch });
    expect(result.botUserId).toBe(5);
    expect(result.botToken).toBe("tok_xyz");
    expect(result.created).toEqual({ user: false, token: true });
  });

  it("is idempotent: existing user + existing token returns empty token", async () => {
    const f = bootstrapFetchScenario({ userExists: true, tokenExists: true });
    const result = await bootstrapBot({ ...baseOpts, fetchImpl: f as unknown as typeof fetch });
    expect(result.botUserId).toBe(5);
    expect(result.botToken).toBe("");
    expect(result.created).toEqual({ user: false, token: false });
  });
});
