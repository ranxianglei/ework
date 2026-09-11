import { provisionUser, type UserRow } from "./store";

export interface AuthHookResult {
  /** Must match /^[A-Za-z0-9_-]{1,64}$/ — enforced for cookie-safety. */
  login: string;
  /** If true, user is promoted to site-admin (one-way: never demotes). */
  isAdmin?: boolean;
  /** User kind for auto-provisioning. Defaults to "human". */
  kind?: "human" | "bot" | "system";
}

export interface AuthProvider {
  /**
   * Return user identity or null. Do NOT throw on auth failure —
   * return null. Exceptions are caught and logged by the caller.
   */
  authenticate(req: Request): Promise<AuthHookResult | null>;
}

const LOGIN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const hookCache = new Map<string, AuthProvider | null>();

async function loadHook(hookPath: string): Promise<AuthProvider | null> {
  const cached = hookCache.get(hookPath);
  if (cached !== undefined) return cached;

  try {
    const path = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const abs = path.isAbsolute(hookPath) ? hookPath : path.resolve(process.cwd(), hookPath);
    const mod = await import(pathToFileURL(abs).href);
    const provider: AuthProvider = mod.default ?? mod;
    if (!provider || typeof provider.authenticate !== "function") {
      console.warn(`[auth-hook] ${hookPath}: must export an object with authenticate()`);
      hookCache.set(hookPath, null);
      return null;
    }
    hookCache.set(hookPath, provider);
    return provider;
  } catch (e) {
    console.warn(`[auth-hook] failed to load ${hookPath}:`, e);
    hookCache.set(hookPath, null);
    return null;
  }
}

export async function runAuthHook(hookPath: string, req: Request): Promise<UserRow | null> {
  if (!hookPath) return null;

  const provider = await loadHook(hookPath);
  if (!provider) return null;

  let result: AuthHookResult | null;
  try {
    result = await provider.authenticate(req);
  } catch (e) {
    console.warn(`[auth-hook] ${hookPath}: authenticate() threw:`, e);
    return null;
  }

  if (!result?.login) return null;

  // v2 cookies split on "." — LOGIN_RE prevents dots/special chars that
  // would break the split or enable cookie injection.
  if (!LOGIN_RE.test(result.login)) {
    console.warn(`[auth-hook] ${hookPath}: invalid login format (must match ${LOGIN_RE})`);
    return null;
  }

  const user = await provisionUser(result.login, {
    kind: result.kind ?? "human",
    isAdmin: result.isAdmin ?? false,
  });

  if (!user.is_active) return null;
  return user;
}

export function clearAuthHookCache(): void {
  hookCache.clear();
}
