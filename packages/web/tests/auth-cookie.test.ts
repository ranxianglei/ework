import { describe, expect, test } from "bun:test";
import { configSchema } from "../src/config";
import {
  AUTH_COOKIE_NAME,
  authCookieName,
  clearAuthCookieHeader,
  makeAuthCookieHeader,
} from "../src/auth";

function cfgWith(over: Record<string, unknown>) {
  return configSchema.parse({
    authToken: "t-token-8chars",
    cookieSecret: "s-secret-8chars",
    ...over,
  });
}

describe("auth cookie naming", () => {
  test("default name is the historical constant", () => {
    const cfg = cfgWith({});
    expect(authCookieName(cfg)).toBe(AUTH_COOKIE_NAME);
  });

  test("WORK_COOKIE_NAME-style override changes set and clear headers", async () => {
    const cfg = cfgWith({ cookieName: "ework_auth_host" });
    const set = await makeAuthCookieHeader(cfg, "dog");
    expect(set.startsWith("ework_auth_host=v2.dog.")).toBe(true);
    const clear = clearAuthCookieHeader(cfg);
    expect(clear.startsWith("ework_auth_host=;")).toBe(true);
  });

  test("override and default coexist (same-domain deployments do not kick each other)", async () => {
    const a = await makeAuthCookieHeader(cfgWith({}), "dog");
    const b = await makeAuthCookieHeader(cfgWith({ cookieName: "ework_auth_host" }), "dog");
    const nameOf = (h: string) => h.slice(0, h.indexOf("="));
    expect(nameOf(a)).not.toBe(nameOf(b));
  });

  test("secureCookie prefixes the overridden name too", async () => {
    const cfg = cfgWith({ cookieName: "ework_auth_host", secureCookie: true });
    expect(authCookieName(cfg)).toBe("__Host-ework_auth_host");
    expect((await makeAuthCookieHeader(cfg, "dog")).includes("Secure")).toBe(true);
  });

  test("invalid override names are rejected by the schema", () => {
    expect(() => cfgWith({ cookieName: "bad name; Path=/" })).toThrow();
  });
});
