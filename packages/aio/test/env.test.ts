import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseEnvFile,
  forwardFill,
  serializeEnvFile,
  ensureEnvFile,
  readEnvFile,
  patchEnvKey,
} from "../src/env.ts";
import { WEB_ENV_KEYS, DAEMON_ENV_KEYS, type InstallContext } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";

function makeCtx(overrides: Partial<InstallContext> = {}): InstallContext {
  const paths = resolvePaths({
    scope: "user",
    useSystemd: false,
    dataDir: overrides.paths?.dataDir ?? "/tmp/ework-aio-test",
  });
  return {
    paths,
    workPort: 3002,
    daemonPort: 3101,
    botName: "ework-daemon",
    operatorLogin: "testuser",
    opencodeBin: "/usr/local/bin/opencode",
    ...overrides,
  };
}

describe("parseEnvFile", () => {
  it("parses basic KEY=value lines", () => {
    const parsed = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(parsed.entries.get("FOO")).toBe("bar");
    expect(parsed.entries.get("BAZ")).toBe("qux");
  });

  it("strips matching double quotes", () => {
    const parsed = parseEnvFile('FOO="hello world"');
    expect(parsed.entries.get("FOO")).toBe("hello world");
  });

  it("strips matching single quotes", () => {
    const parsed = parseEnvFile("FOO='hello world'");
    expect(parsed.entries.get("FOO")).toBe("hello world");
  });

  it("does not strip unmatched quotes", () => {
    const parsed = parseEnvFile('FOO="bar\'');
    expect(parsed.entries.get("FOO")).toBe('"bar\'');
  });

  it("preserves comments and blank lines in rawLines", () => {
    const content = "# header comment\n\nFOO=bar\n\n# trailing comment\n";
    const parsed = parseEnvFile(content);
    expect(parsed.entries.get("FOO")).toBe("bar");
    expect(parsed.rawLines).toEqual([
      "# header comment",
      "",
      "FOO=bar",
      "",
      "# trailing comment",
      "",
    ]);
  });

  it("skips malformed lines (no = sign)", () => {
    const parsed = parseEnvFile("FOO=bar\nMALFORMED_LINE\nBAZ=qux\n");
    expect(parsed.entries.get("FOO")).toBe("bar");
    expect(parsed.entries.has("MALFORMED_LINE")).toBe(false);
    expect(parsed.entries.get("BAZ")).toBe("qux");
  });
});

describe("forwardFill", () => {
  it("adds all required keys when given an empty env", () => {
    const ctx = makeCtx();
    const parsed = parseEnvFile("");
    const result = forwardFill(parsed, "web", ctx);
    expect(result.added.sort()).toEqual(
      WEB_ENV_KEYS.map((k) => k.envVar).sort(),
    );
    // Every required key should now be in the merged map.
    for (const spec of WEB_ENV_KEYS) {
      expect(result.merged.has(spec.envVar)).toBe(true);
    }
  });

  it("does NOT overwrite user-set values", () => {
    const ctx = makeCtx();
    // User has customized WORK_PORT to 9999
    const parsed = parseEnvFile("WORK_PORT=9999\n");
    const result = forwardFill(parsed, "web", ctx);
    expect(result.merged.get("WORK_PORT")).toBe("9999");
    expect(result.added).not.toContain("WORK_PORT");
  });

  it("adds missing keys while preserving existing ones", () => {
    const ctx = makeCtx();
    // Simulate the v0.1.17 bug: stale .env missing WORK_COOKIE_SECRET
    const stale = [
      "WORK_PORT=3002",
      "WORK_TOKEN=existing-token",
      "WORK_OPERATOR_LOGIN=admin",
      "", // blank line
      "# user comment",
    ].join("\n");
    const parsed = parseEnvFile(stale);
    const result = forwardFill(parsed, "web", ctx);

    // WORK_COOKIE_SECRET was missing → should be added
    expect(result.added).toContain("WORK_COOKIE_SECRET");
    expect(result.merged.get("WORK_COOKIE_SECRET")?.length ?? 0).toBeGreaterThan(0);

    // WORK_TOKEN was already present → untouched
    expect(result.merged.get("WORK_TOKEN")).toBe("existing-token");
    expect(result.added).not.toContain("WORK_TOKEN");

    // WORK_PORT was already present → untouched
    expect(result.merged.get("WORK_PORT")).toBe("3002");
  });

  it("adds 0 keys when all required keys already present", () => {
    const ctx = makeCtx();
    const fullEnv = WEB_ENV_KEYS.map((k) => `${k.envVar}=value`).join("\n");
    const parsed = parseEnvFile(fullEnv);
    const result = forwardFill(parsed, "web", ctx);
    expect(result.added).toEqual([]);
  });

  it("generates fresh random values for missing secret keys", () => {
    const ctx = makeCtx();
    const parsed1 = parseEnvFile("");
    const r1 = forwardFill(parsed1, "web", ctx);
    const parsed2 = parseEnvFile("");
    const r2 = forwardFill(parsed2, "web", ctx);

    // Secrets should differ between two runs (random)
    expect(r1.merged.get("WORK_TOKEN")).not.toBe(r2.merged.get("WORK_TOKEN"));
    expect(r1.merged.get("WORK_COOKIE_SECRET")).not.toBe(r2.merged.get("WORK_COOKIE_SECRET"));
  });

  it("fills all daemon keys including empty-string token placeholders", () => {
    const ctx = makeCtx();
    const parsed = parseEnvFile("");
    const result = forwardFill(parsed, "daemon", ctx);
    expect(result.added.sort()).toEqual(
      DAEMON_ENV_KEYS.map((k) => k.envVar).sort(),
    );
    // Per config spec, GITEA_TOKEN / BOT_TOKEN generate empty strings
    // (filled in later by bootstrap after PAT is minted).
    expect(result.merged.get("GITEA_TOKEN")).toBe("");
    expect(result.merged.get("BOT_TOKEN")).toBe("");
  });
});

describe("serializeEnvFile", () => {
  it("appends new keys at end with a header comment", () => {
    const parsed = parseEnvFile("FOO=bar\n# user comment\n");
    const out = serializeEnvFile(parsed, [
      { key: "BAZ", value: "qux" },
    ]);
    // Original content preserved
    expect(out).toContain("FOO=bar");
    expect(out).toContain("# user comment");
    // New key appended
    expect(out).toContain("BAZ=qux");
    // Forward-fill header
    expect(out).toMatch(/# ework-aio forward-fill at \d{4}-\d{2}-\d{2}T/);
  });

  it("returns content unchanged when no keys were added", () => {
    const parsed = parseEnvFile("FOO=bar\n");
    const out = serializeEnvFile(parsed, []);
    expect(out).toBe("FOO=bar\n");
  });

  it("trims trailing blank lines before appending", () => {
    const parsed = parseEnvFile("FOO=bar\n\n\n");
    const out = serializeEnvFile(parsed, [{ key: "BAZ", value: "qux" }]);
    // Should not have 3 blank lines between FOO and the forward-fill header
    expect(out).not.toMatch(/bar\n\n\n\n/);
  });
});

describe("ensureEnvFile (end-to-end)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-aio-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a fresh .env when none exists, with all required keys", async () => {
    const ctx = makeCtx();
    const envPath = path.join(tmpDir, ".env");
    const result = await ensureEnvFile({ file: "web", filePath: envPath, ctx });

    expect(result.created).toBe(true);
    expect(result.added.sort()).toEqual(WEB_ENV_KEYS.map((k) => k.envVar).sort());

    const written = await fs.promises.readFile(envPath, "utf8");
    expect(written).toContain("WORK_PORT=3002");
    expect(written).toContain("WORK_COOKIE_SECRET=");
    // File mode should be 0600
    const stat = await fs.promises.stat(envPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("preserves existing .env and only adds missing keys (the v0.1.17 regression)", async () => {
    const ctx = makeCtx();
    const envPath = path.join(tmpDir, ".env");

    // Simulate a stale .env from an older install
    const staleContent = [
      "# user's original header comment",
      "WORK_PORT=3002",
      "WORK_HOST=127.0.0.1",
      "WORK_TOKEN=old-user-token-value",
      "WORK_OPERATOR_LOGIN=admin",
      "", // blank line at end
    ].join("\n");
    await fs.promises.writeFile(envPath, staleContent, { mode: 0o600 });

    const result = await ensureEnvFile({ file: "web", filePath: envPath, ctx });

    expect(result.created).toBe(false);
    // WORK_COOKIE_SECRET must be added (the bug)
    expect(result.added).toContain("WORK_COOKIE_SECRET");
    // WORK_PORT must NOT be re-added (it was present)
    expect(result.added).not.toContain("WORK_PORT");
    // WORK_TOKEN must NOT be re-added
    expect(result.added).not.toContain("WORK_TOKEN");

    const written = await fs.promises.readFile(envPath, "utf8");
    // User's comment preserved
    expect(written).toContain("# user's original header comment");
    // User's existing values preserved
    expect(written).toContain("WORK_PORT=3002");
    expect(written).toContain("WORK_TOKEN=old-user-token-value");
    // Missing key now present
    expect(written).toMatch(/WORK_COOKIE_SECRET=[a-f0-9]+/);
    // Forward-fill section header
    expect(written).toMatch(/# ework-aio forward-fill at /);
  });

  it("is idempotent: running twice doesn't add keys the second time", async () => {
    const ctx = makeCtx();
    const envPath = path.join(tmpDir, ".env");

    const r1 = await ensureEnvFile({ file: "web", filePath: envPath, ctx });
    expect(r1.created).toBe(true);
    expect(r1.added.length).toBe(WEB_ENV_KEYS.length);

    const r2 = await ensureEnvFile({ file: "web", filePath: envPath, ctx });
    expect(r2.created).toBe(false);
    expect(r2.added).toEqual([]);
  });

  it("does not overwrite user-customized values on re-run", async () => {
    const ctx = makeCtx();
    const envPath = path.join(tmpDir, ".env");

    // First install: fresh .env
    await ensureEnvFile({ file: "web", filePath: envPath, ctx });

    // User edits WORK_PORT to a custom value
    const edited = (await fs.promises.readFile(envPath, "utf8"))
      .replace(/^WORK_PORT=.*$/m, "WORK_PORT=9999  # custom");
    await fs.promises.writeFile(envPath, edited, { mode: 0o600 });

    // Re-run install
    const result = await ensureEnvFile({ file: "web", filePath: envPath, ctx });
    expect(result.added).not.toContain("WORK_PORT");

    const final = await fs.promises.readFile(envPath, "utf8");
    expect(final).toMatch(/WORK_PORT=9999  # custom/);
  });
});

describe("readEnvFile", () => {
  it("returns null for missing file", async () => {
    const result = await readEnvFile("/nonexistent/path/.env");
    expect(result).toBeNull();
  });

  it("round-trips through write/read", async () => {
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ework-aio-rt-")),
      ".env",
    );
    try {
      const ctx = makeCtx();
      await ensureEnvFile({ file: "web", filePath: tmpFile, ctx });
      const readBack = await readEnvFile(tmpFile);
      expect(readBack).not.toBeNull();
      expect(readBack!.entries.has("WORK_COOKIE_SECRET")).toBe(true);
    } finally {
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    }
  });
});

describe("patchEnvKey (B-1: tolerance aligned with parseEnvFile)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-patch-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces a value when the key is in canonical 'KEY=value' form", async () => {
    const envFile = path.join(tmpDir, ".env");
    await fs.promises.writeFile(envFile, "FOO=old\nBAR=keep\n", { mode: 0o600 });
    await patchEnvKey(envFile, "FOO", "new");
    const after = await fs.promises.readFile(envFile, "utf8");
    expect(after).toBe("FOO=new\nBAR=keep\n");
  });

  // Regression for B-1: parseEnvFile trims the key half of each line, so
  // `KEY = value` parses as key=KEY. patchEnvKey used to require the strict
  // `KEY=` prefix, failed to match the padded form, and appended a duplicate
  // — parseEnvFile then iterated both lines and shadowed values unpredictably.
  it("replaces in place when the existing line has whitespace around '=' (B-1)", async () => {
    const envFile = path.join(tmpDir, ".env");
    await fs.promises.writeFile(envFile, "FOO = old\nBAR=keep\n", { mode: 0o600 });
    await patchEnvKey(envFile, "FOO", "new");
    const after = await fs.promises.readFile(envFile, "utf8");
    expect(after).toBe("FOO=new\nBAR=keep\n");
    expect(after.match(/^FOO/gm)!.length).toBe(1);
  });

  it("appends the key when it is not present", async () => {
    const envFile = path.join(tmpDir, ".env");
    await fs.promises.writeFile(envFile, "FOO=1\n", { mode: 0o600 });
    await patchEnvKey(envFile, "BAR", "2");
    const after = await fs.promises.readFile(envFile, "utf8");
    expect(after).toBe("FOO=1\n\nBAR=2\n");
  });

  it("creates the file if it does not exist", async () => {
    const envFile = path.join(tmpDir, ".env");
    await patchEnvKey(envFile, "FOO", "bar");
    const after = await fs.promises.readFile(envFile, "utf8");
    expect(after).toBe("FOO=bar\n");
  });

  it("does not match comment lines that happen to contain the key text", async () => {
    const envFile = path.join(tmpDir, ".env");
    await fs.promises.writeFile(envFile, "# FOO=old\nFOO=real\n", { mode: 0o600 });
    await patchEnvKey(envFile, "FOO", "new");
    const after = await fs.promises.readFile(envFile, "utf8");
    expect(after).toBe("# FOO=old\nFOO=new\n");
  });
});
