import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplatedWorkdir, runHookScript } from "../src/opencode";
import { parseGroupConfigHeader } from "../src/server";

function mkIssue(scopeKey: string, issueId: string | number, scope?: Record<string, unknown>) {
  return {
    trackerScopeKey: scopeKey,
    trackerScope: scope ?? {},
    trackerIssueId: issueId,
  };
}

describe("resolveTemplatedWorkdir", () => {
  test("substitutes all variables", () => {
    const dir = resolveTemplatedWorkdir(
      "/data/{owner}/{repo}/i{issue}/{session}",
      mkIssue("acme/widget", "42", { owner: "acme", repo: "widget" }),
      { name: "sess1" },
    );
    expect(dir).toBe("/data/acme/widget/i42/sess1");
  });

  test("falls back to scopeKey parts when trackerScope absent", () => {
    const dir = resolveTemplatedWorkdir(
      "/w/{owner}/{repo}/{issue}",
      mkIssue("fallback/repo-x", "7"),
      { name: "s" },
    );
    expect(dir).toBe("/w/fallback/repo-x/7");
  });

  test("uses 'default' when owner/repo unresolvable", () => {
    const dir = resolveTemplatedWorkdir(
      "/w/{owner}/{repo}/{issue}",
      mkIssue("", "1"),
      { name: "s" },
    );
    expect(dir).toBe("/w/default/default/1");
  });

  test("replaces all occurrences of a variable", () => {
    const dir = resolveTemplatedWorkdir(
      "/w/{issue}/{issue}",
      mkIssue("o/r", "9"),
      { name: "s" },
    );
    expect(dir).toBe("/w/9/9");
  });

  test("expands ~ to homedir", () => {
    const dir = resolveTemplatedWorkdir("~/work/{issue}", mkIssue("o/r", "3"), { name: "s" });
    expect(dir.startsWith("/")).toBe(true);
    expect(dir).not.toContain("~");
    expect(dir.endsWith("/work/3")).toBe(true);
  });

  test("leaves unknown placeholders literally", () => {
    const dir = resolveTemplatedWorkdir(
      "/w/{unknown}/{issue}",
      mkIssue("o/r", "1"),
      { name: "s" },
    );
    expect(dir).toBe("/w/{unknown}/1");
  });
});

describe("parseGroupConfigHeader", () => {
  test("round-trips a full config", () => {
    const cfg = { workdirTemplate: "/w/{owner}/{repo}", initScript: "echo hi", destroyScript: "rm -rf x" };
    const encoded = Buffer.from(JSON.stringify(cfg), "utf8").toString("base64");
    expect(parseGroupConfigHeader(encoded)).toEqual(cfg);
    expect(parseGroupConfigHeader(encoded)).toEqual(cfg);
  });

  test("returns undefined for null/empty", () => {
    expect(parseGroupConfigHeader(null)).toBeUndefined();
    expect(parseGroupConfigHeader("")).toBeUndefined();
    expect(parseGroupConfigHeader(null)).toBeUndefined();
  });

  test("returns undefined for malformed base64/json", () => {
    expect(parseGroupConfigHeader("not-base64-json!!!")).toBeUndefined();
    expect(parseGroupConfigHeader(Buffer.from("{bad json").toString("base64"))).toBeUndefined();
  });

  test("returns undefined for non-object json", () => {
    expect(parseGroupConfigHeader(Buffer.from('"string"').toString("base64"))).toBeUndefined();
    expect(parseGroupConfigHeader(Buffer.from("42").toString("base64"))).toBeUndefined();
    expect(parseGroupConfigHeader(Buffer.from("null").toString("base64"))).toBeUndefined();
  });
});

describe("runHookScript", () => {
  test("no-op on undefined/empty/whitespace", async () => {
    await runHookScript(undefined, "/tmp", "init");
    await runHookScript("", "/tmp", "init");
    await runHookScript("   \n  ", "/tmp", "init");
  });

  test("executes script with workdir as cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ewhook-"));
    try {
      await runHookScript('pwd > cwd.txt', dir, "init");
      const cwd = readFileSync(join(dir, "cwd.txt"), "utf8").trim();
      expect(cwd).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates workdir if it does not exist", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ewp-")), "nested", "deep");
    try {
      await runHookScript("echo ok > done.txt", dir, "init");
      expect(readFileSync(join(dir, "done.txt"), "utf8").trim()).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("script can write env-templated content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ewenv-"));
    try {
      writeFileSync(join(dir, "existing.txt"), "data");
      await runHookScript("cat existing.txt > out.txt", dir, "init");
      expect(readFileSync(join(dir, "out.txt"), "utf8").trim()).toBe("data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never throws on script failure", async () => {
    await expect(runHookScript("exit 1", "/tmp", "init")).resolves.toBeUndefined();
    await expect(runHookScript("false", "/tmp", "init")).resolves.toBeUndefined();
  });

  test("never throws on nonexistent shell command", async () => {
    await expect(runHookScript("this-cmd-does-not-exist-xyz", "/tmp", "init")).resolves.toBeUndefined();
  });

  test("injects EWORK_* env vars into script environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ewenv2-"));
    try {
      await runHookScript(
        'echo "$EWORK_OWNER/$EWORK_REPO/issue-$EWORK_ISSUE" > env.txt',
        dir,
        "init",
        { EWORK_OWNER: "acme", EWORK_REPO: "widget", EWORK_ISSUE: "42", EWORK_SESSION: "s1", EWORK_WORKDIR: dir },
      );
      const content = readFileSync(join(dir, "env.txt"), "utf8").trim();
      expect(content).toBe("acme/widget/issue-42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injects EWORK_SENDER env var into script environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ewenv-sender-"));
    try {
      await runHookScript(
        'echo "sender=$EWORK_SENDER" > sender.txt',
        dir,
        "init",
        { EWORK_OWNER: "acme", EWORK_REPO: "widget", EWORK_ISSUE: "42", EWORK_SESSION: "s1", EWORK_WORKDIR: dir, EWORK_SENDER: "alice" },
      );
      const content = readFileSync(join(dir, "sender.txt"), "utf8").trim();
      expect(content).toBe("sender=alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("kills hung scripts within timeout bound", async () => {
    const start = Date.now();
    await runHookScript("sleep 30", "/tmp", "init", {}, 500);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(elapsed).toBeGreaterThan(300);
  });
});
