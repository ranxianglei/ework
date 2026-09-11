import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  readConfig,
  writeConfig,
  hasPlugin,
  ensurePlugin,
  removePlugin,
  ensurePluginInFile,
  type OpencodeConfig,
} from "../src/opencode-config.ts";

describe("readConfig", () => {
  let tmpDir: string;
  let configPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-opencode-"));
    configPath = path.join(tmpDir, "opencode.json");
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns empty config when file doesn't exist", async () => {
    const { config, existed } = await readConfig(configPath);
    expect(existed).toBe(false);
    expect(config).toEqual({});
  });

  it("parses valid JSON object", async () => {
    await fs.promises.writeFile(configPath, '{"foo": 1, "plugin": ["x"]}');
    const { config, existed } = await readConfig(configPath);
    expect(existed).toBe(true);
    expect(config.foo).toBe(1);
    expect(config.plugin).toEqual(["x"]);
  });

  it("throws typed InstallError on malformed JSON", async () => {
    await fs.promises.writeFile(configPath, "{not valid json");
    await expect(readConfig(configPath)).rejects.toThrow(/malformed JSON/);
  });

  it("throws typed InstallError on top-level array", async () => {
    await fs.promises.writeFile(configPath, "[1, 2, 3]");
    await expect(readConfig(configPath)).rejects.toThrow(/JSON object at the top level/);
  });

  it("throws typed InstallError on top-level null", async () => {
    await fs.promises.writeFile(configPath, "null");
    await expect(readConfig(configPath)).rejects.toThrow(/JSON object at the top level/);
  });
});

describe("hasPlugin / ensurePlugin / removePlugin (in-memory)", () => {
  it("hasPlugin returns false when plugins array missing", () => {
    expect(hasPlugin({}, "x")).toBe(false);
  });

  it("hasPlugin matches string-form entries", () => {
    expect(hasPlugin({ plugin: ["foo", "bar"] }, "bar")).toBe(true);
  });

  it("hasPlugin matches object-form entries", () => {
    expect(hasPlugin({ plugin: [{ name: "foo" }, { name: "bar", opts: 1 }] }, "bar")).toBe(true);
  });

  it("hasPlugin ignores malformed entries", () => {
    const malformed: unknown[] = [{ no_name: true }, null, 42, ""];
    expect(hasPlugin({ plugin: malformed as OpencodeConfig["plugin"] }, "x")).toBe(false);
  });

  it("ensurePlugin appends when missing", () => {
    const result = ensurePlugin({ plugin: ["foo"] }, "bar");
    expect(result.added).toBe(true);
    expect(result.config.plugin).toEqual(["foo", "bar"]);
  });

  it("ensurePlugin is idempotent when present", () => {
    const result = ensurePlugin({ plugin: ["foo", "bar"] }, "bar");
    expect(result.added).toBe(false);
    expect(result.config.plugin).toEqual(["foo", "bar"]);
  });

  it("ensurePlugin creates plugins array when absent", () => {
    const result = ensurePlugin({ unrelated: 1 }, "foo");
    expect(result.added).toBe(true);
    expect(result.config.plugin).toEqual(["foo"]);
    expect(result.config.unrelated).toBe(1); // unknown key passthrough preserved
  });

  it("removePlugin removes by name (string form)", () => {
    const result = removePlugin({ plugin: ["foo", "bar"] }, "bar");
    expect(result.removed).toBe(true);
    expect(result.config.plugin).toEqual(["foo"]);
  });

  it("removePlugin removes by name (object form)", () => {
    const result = removePlugin({ plugin: [{ name: "foo" }] }, "foo");
    expect(result.removed).toBe(true);
    expect(result.config.plugin).toEqual([]);
  });

  it("removePlugin is idempotent when not present", () => {
    const result = removePlugin({ plugin: ["foo"] }, "bar");
    expect(result.removed).toBe(false);
  });
});

describe("writeConfig + ensurePluginInFile (end-to-end)", () => {
  let tmpDir: string;
  let configPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ework-opencode-e2e-"));
    configPath = path.join(tmpDir, "opencode.json");
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes then reads back", async () => {
    await writeConfig(configPath, { foo: 1, plugin: ["a"] });
    const { config } = await readConfig(configPath);
    expect(config.foo).toBe(1);
    expect(config.plugin).toEqual(["a"]);
  });

  it("preserves unknown keys when adding plugin", async () => {
    await writeConfig(configPath, { unrelated: "keep-me", plugin: ["existing"] });
    const result = await ensurePluginInFile(configPath, "opencode-ework");
    expect(result.added).toBe(true);

    const { config } = await readConfig(configPath);
    expect(config.unrelated).toBe("keep-me");
    expect(config.plugin).toEqual(["existing", "opencode-ework"]);
  });

  it("is idempotent on second call", async () => {
    await ensurePluginInFile(configPath, "opencode-ework");
    const result = await ensurePluginInFile(configPath, "opencode-ework");
    expect(result.added).toBe(false);
  });

  it("registers plugin when file doesn't exist yet", async () => {
    const result = await ensurePluginInFile(configPath, "opencode-ework");
    expect(result.added).toBe(true);
    const { config } = await readConfig(configPath);
    expect(config.plugin).toEqual(["opencode-ework"]);
  });

  // G32: object-form plugin entry (with opts) must be preserved verbatim
  // when adding a new plugin. A regression that normalizes object-form to
  // string-form would silently drop user configuration (plugin opts,
  // enabled flag, etc).
  it("preserves object-form plugin entries (with opts) when adding a new plugin (G32)", async () => {
    await writeConfig(configPath, {
      plugin: [
        { name: "existing-plugin", opts: { foo: 1, bar: ["a", "b"] } },
        { name: "another", enabled: true },
      ],
    });
    const result = await ensurePluginInFile(configPath, "opencode-ework");
    expect(result.added).toBe(true);

    const { config } = await readConfig(configPath);
    expect(config.plugin).toHaveLength(3);
    // Object-form entries preserved exactly (deep equality).
    expect(config.plugin![0]).toEqual({ name: "existing-plugin", opts: { foo: 1, bar: ["a", "b"] } });
    expect(config.plugin![1]).toEqual({ name: "another", enabled: true });
    // New plugin appended.
    expect(config.plugin![2]).toBe("opencode-ework");
  });

  it("preserves object-form entry alongside string-form entries", async () => {
    await writeConfig(configPath, {
      plugin: ["string-form", { name: "object-form", opts: 42 }],
    });
    await ensurePluginInFile(configPath, "new-plugin");
    const { config } = await readConfig(configPath);
    expect(config.plugin).toEqual(["string-form", { name: "object-form", opts: 42 }, "new-plugin"]);
  });

  it("writeConfig writes mode 0644", async () => {
    await writeConfig(configPath, { plugin: [] });
    const stat = await fs.promises.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o644);
  });

  // v0.2.0-v0.2.3 regression: installer wrote the WRONG key "plugins"
  // (plural). opencode's schema has additionalProperties: false at top
  // level, so the bad key made every opencode command fail with
  // "Unrecognized key: plugins". User hit this as: clicking any session
  // in awork-web fails because awork-web calls `opencode export ses_xxx`
  // and opencode rejects its own config before doing anything.
  //
  // readConfig transparently migrates the bad key on load. ensurePluginInFile
  // then writes the corrected shape back to disk, healing the user's config
  // without requiring manual editing.
  it("readConfig migrates legacy 'plugins' (plural) key into 'plugin'", async () => {
    // Manually write the broken shape (what v0.2.3 produced on user's disk).
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ plugins: ["opencode-ework@latest"] }) + "\n",
    );
    const { config } = await readConfig(configPath);
    expect(config.plugin).toEqual(["opencode-ework@latest"]);
    expect(config.plugins).toBeUndefined();
  });

  it("readConfig migration dedupes when both 'plugins' and 'plugin' exist", async () => {
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({
        plugin: ["opencode-ework@latest"],
        plugins: ["opencode-ework@latest", "other-plugin@1.0.0"],
      }) + "\n",
    );
    const { config } = await readConfig(configPath);
    // 'other-plugin' should be merged in; 'opencode-ework' should not duplicate.
    expect(config.plugin).toEqual(["opencode-ework@latest", "other-plugin@1.0.0"]);
    expect(config.plugins).toBeUndefined();
  });

  it("readConfig drops a non-array legacy 'plugins' key", async () => {
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ plugins: "not-an-array" }) + "\n",
    );
    const { config } = await readConfig(configPath);
    expect(config.plugins).toBeUndefined();
    expect(config.plugin).toBeUndefined();
  });

  it("ensurePluginInFile persists the migrated shape to disk (self-heal on reinstall)", async () => {
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ plugins: ["opencode-ework@latest"], theme: "dark" }) + "\n",
    );
    await ensurePluginInFile(configPath, "opencode-ework@latest");
    const raw = await Bun.file(configPath).text();
    const parsed = JSON.parse(raw);
    // Bad key must be gone, good key must be present, unrelated keys preserved.
    expect(parsed.plugins).toBeUndefined();
    expect(parsed.plugin).toEqual(["opencode-ework@latest"]);
    expect(parsed.theme).toBe("dark");
  });
});
