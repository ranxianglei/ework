import { describe, it, expect } from "bun:test";
import { pickLastActive } from "../src/opencode";
import type { OpSession } from "../src/trackers/types";

function mkSession(id: string, createdAtMs: number, startedAt?: number): OpSession {
  const s: OpSession = { id, issueId: "i1", name: id, state: "idle", createdAt: new Date(createdAtMs) };
  if (startedAt !== undefined) s.startedAt = startedAt;
  return s;
}

describe("pickLastActive", () => {
  it("returns undefined for an empty list", () => {
    expect(pickLastActive([])).toBeUndefined();
  });

  it("returns the only session", () => {
    const s = mkSession("a", 1000);
    expect(pickLastActive([s])).toBe(s);
  });

  it("picks the most recently started session", () => {
    const a = mkSession("a", 1000, 5000);
    const b = mkSession("b", 2000, 9000);
    const c = mkSession("c", 3000, 7000);
    expect(pickLastActive([a, b, c])).toBe(b);
  });

  it("falls back to createdAt when startedAt is missing", () => {
    const a = mkSession("a", 1000);
    const b = mkSession("b", 5000);
    expect(pickLastActive([a, b])).toBe(b);
  });

  it("a just-created (never-run) session beats an older-run one", () => {
    const a = mkSession("a", 1000, 8000);
    const b = mkSession("b", 9000);
    expect(pickLastActive([a, b])).toBe(b);
  });
});
