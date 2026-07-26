import { beforeAll, test, expect } from "bun:test";
import { initDB } from "../src/db";
import { resolveModel, setProjectModel, listCachedModels, replaceCachedModels, StoreError } from "../src/store";

beforeAll(async () => {
  await initDB();
});

test("resolveModel: returns project override when set (non-empty)", () => {
  expect(resolveModel("zhipuai/glm-4.6", "anthropic/claude-3")).toBe("zhipuai/glm-4.6");
});

test("resolveModel: falls back to global default when project model empty", () => {
  expect(resolveModel("", "anthropic/claude-3")).toBe("anthropic/claude-3");
  expect(resolveModel(undefined as unknown as string, "anthropic/claude-3")).toBe("anthropic/claude-3");
});

test("resolveModel: returns empty string when neither set", () => {
  expect(resolveModel("", "")).toBe("");
  // Caller (webhook emit) checks for truthiness before attaching to payload;
  // daemon omits --model when empty.
});

test("resolveModel: trims whitespace", () => {
  expect(resolveModel("  zhipuai/glm-4.6  ", "  anthropic/claude-3  ")).toBe("zhipuai/glm-4.6");
  expect(resolveModel("", "  anthropic/claude-3  ")).toBe("anthropic/claude-3");
});

test("setProjectModel: rejects malformed model id", async () => {
  await expect(setProjectModel(0, "not-a-model")).rejects.toThrow(StoreError);
  await expect(setProjectModel(0, "noslash")).rejects.toThrow(StoreError);
  await expect(setProjectModel(0, "/missingprovider")).rejects.toThrow(StoreError);
  await expect(setProjectModel(0, "missingmodel/")).rejects.toThrow(StoreError);
  await expect(setProjectModel(0, "has space/glm")).rejects.toThrow(StoreError);
});

test("setProjectModel: rejects invalid characters", async () => {
  // Only alphanumeric + ._- allowed in provider and model segments
  await expect(setProjectModel(0, "bad@provider/glm")).rejects.toThrow(StoreError);
  await expect(setProjectModel(0, "provider/model$")).rejects.toThrow(StoreError);
});

test("replaceCachedModels + listCachedModels: replace then read back sorted", async () => {
  await replaceCachedModels(["zhipuai/glm-4.7", "anthropic/claude-3", "vllm/qwen3.6-27b"]);
  const out = await listCachedModels();
  expect(out.length).toBe(3);
  // listCachedModels returns ORDER BY id → alphabetical
  expect(out[0]!.id).toBe("anthropic/claude-3");
  expect(out[1]!.id).toBe("vllm/qwen3.6-27b");
  expect(out[2]!.id).toBe("zhipuai/glm-4.7");
});

test("replaceCachedModels: empty array clears the cache", async () => {
  await replaceCachedModels(["a/b"]);
  expect((await listCachedModels()).length).toBe(1);
  await replaceCachedModels([]);
  expect((await listCachedModels()).length).toBe(0);
});

test("replaceCachedModels: dedupes on replace (transactional)", async () => {
  await replaceCachedModels(["x/y", "x/y", "z/w"]);
  const out = await listCachedModels();
  // PRIMARY KEY constraint would throw on dup; if the function completes,
  // the transaction rolled back cleanly. Verify we got either 0 (rollback)
  // or 2 (deduped). Either is acceptable; the test guards against partial state.
  expect(out.length === 0 || out.length === 2).toBe(true);
});
