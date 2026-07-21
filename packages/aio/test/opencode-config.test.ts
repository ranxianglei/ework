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
    await fs.promises.writeFile(configPath, '{"foo": 1, "plugins": ["x"]}');
    const { config, existed } = await readConfig(configPath);
    expect(existed).toBe(true);
    expect(config.foo).toBe(1);
    expect(config.plugins).toEqual(["x"]);
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
    expect(hasPlugin({ plugins: ["foo", "bar"] }, "bar")).toBe(true);
  });

  it("hasPlugin matches object-form entries", () => {
    expect(hasPlugin({ plugins: [{ name: "foo" }, { name: "bar", opts: 1 }] }, "bar")).toBe(true);
  });

  it("hasPlugin ignores malformed entries", () => {
    const malformed: unknown[] = [{ no_name: true }, null, 42, ""];
    expect(hasPlugin({ plugins: malformed as OpencodeConfig["plugins"] }, "x")).toBe(false);
  });

  it("ensurePlugin appends when missing", () => {
    const result = ensurePlugin({ plugins: ["foo"] }, "bar");
    expect(result.added).toBe(true);
    expect(result.config.plugins).toEqual(["foo", "bar"]);
  });

  it("ensurePlugin is idempotent when present", () => {
    const result = ensurePlugin({ plugins: ["foo", "bar"] }, "bar");
    expect(result.added).toBe(false);
    expect(result.config.plugins).toEqual(["foo", "bar"]);
  });

  it("ensurePlugin creates plugins array when absent", () => {
    const result = ensurePlugin({ unrelated: 1 }, "foo");
    expect(result.added).toBe(true);
    expect(result.config.plugins).toEqual(["foo"]);
    expect(result.config.unrelated).toBe(1); // unknown key passthrough preserved
  });

  it("removePlugin removes by name (string form)", () => {
    const result = removePlugin({ plugins: ["foo", "bar"] }, "bar");
    expect(result.removed).toBe(true);
    expect(result.config.plugins).toEqual(["foo"]);
  });

  it("removePlugin removes by name (object form)", () => {
    const result = removePlugin({ plugins: [{ name: "foo" }] }, "foo");
    expect(result.removed).toBe(true);
    expect(result.config.plugins).toEqual([]);
  });

  it("removePlugin is idempotent when not present", () => {
    const result = removePlugin({ plugins: ["foo"] }, "bar");
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
    await writeConfig(configPath, { foo: 1, plugins: ["a"] });
    const { config } = await readConfig(configPath);
    expect(config.foo).toBe(1);
    expect(config.plugins).toEqual(["a"]);
  });

  it("preserves unknown keys when adding plugin", async () => {
    await writeConfig(configPath, { unrelated: "keep-me", plugins: ["existing"] });
    const result = await ensurePluginInFile(configPath, "opencode-ework");
    expect(result.added).toBe(true);

    const { config } = await readConfig(configPath);
    expect(config.unrelated).toBe("keep-me");
    expect(config.plugins).toEqual(["existing", "opencode-ework"]);
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
    expect(config.plugins).toEqual(["opencode-ework"]);
  });

  // G32: object-form plugin entry (with opts) must be preserved verbatim
  // when adding a new plugin. A regression that normalizes object-form to
  // string-form would silently drop user configuration (plugin opts,
  // enabled flag, etc).
  it("preserves object-form plugin entries (with opts) when adding a new plugin (G32)", async () => {
    await writeConfig(configPath, {
      plugins: [
        { name: "existing-plugin", opts: { foo: 1, bar: ["a", "b"] } },
        { name: "another", enabled: true },
      ],
    });
    const result = await ensurePluginInFile(configPath, "opencode-ework");
    expect(result.added).toBe(true);

    const { config } = await readConfig(configPath);
    expect(config.plugins).toHaveLength(3);
    // Object-form entries preserved exactly (deep equality).
    expect(config.plugins![0]).toEqual({ name: "existing-plugin", opts: { foo: 1, bar: ["a", "b"] } });
    expect(config.plugins![1]).toEqual({ name: "another", enabled: true });
    // New plugin appended.
    expect(config.plugins![2]).toBe("opencode-ework");
  });

  it("preserves object-form entry alongside string-form entries", async () => {
    await writeConfig(configPath, {
      plugins: ["string-form", { name: "object-form", opts: 42 }],
    });
    await ensurePluginInFile(configPath, "new-plugin");
    const { config } = await readConfig(configPath);
    expect(config.plugins).toEqual(["string-form", { name: "object-form", opts: 42 }, "new-plugin"]);
  });

  it("writeConfig writes mode 0644", async () => {
    await writeConfig(configPath, { plugins: [] });
    const stat = await fs.promises.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o644);
  });
});
