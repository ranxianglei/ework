import { describe, test, expect } from "bun:test";
import { ciProbeDecision, type CiProbeState } from "../src/upstream-sync";

describe("ciProbeDecision", () => {
  test("first failing sha emits and counts the attempt", () => {
    const d = ciProbeDecision(null, "abc", 2);
    expect(d.emit).toBe(true);
    expect(d.next).toEqual({ sha: "abc", attempts: 1 });
  });

  test("same sha never re-emits (loop guard)", () => {
    const stored: CiProbeState = { sha: "abc", attempts: 1 };
    expect(ciProbeDecision(stored, "abc", 3).emit).toBe(false);
  });

  test("new sha after a fix attempt emits again", () => {
    const stored: CiProbeState = { sha: "abc", attempts: 1 };
    const d = ciProbeDecision(stored, "def", 1);
    expect(d.emit).toBe(true);
    expect(d.next).toEqual({ sha: "def", attempts: 2 });
  });

  test("two attempts exhausted stops dispatching", () => {
    const stored: CiProbeState = { sha: "def", attempts: 2 };
    expect(ciProbeDecision(stored, "ghi", 4).emit).toBe(false);
  });

  test("green build clears state so future failures get a fresh budget", () => {
    const stored: CiProbeState = { sha: "def", attempts: 2 };
    expect(ciProbeDecision(stored, "zzz", 0).next).toBeNull();
  });
});

// PR#3886 regression companion: probeCiState now returns early while any
// check-run status != "completed" (in-progress runs read as neither green nor
// red). The pure rule below only ever runs on fully-completed check sets:
// same sha must stay silent, a new failing sha must still dispatch.
test("completed-set transitions: same sha silent, new failing sha dispatches", () => {
  const st: CiProbeState = { sha: "abc", attempts: 1 };
  expect(ciProbeDecision(st, "abc", 2).emit).toBe(false);
  const d = ciProbeDecision(st, "xyz", 2);
  expect(d.emit).toBe(true);
  expect(d.next).toEqual({ sha: "xyz", attempts: 2 });
});
