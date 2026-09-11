import { describe, test, expect } from "bun:test";
import { withProvenance, extractProvenance, isSyncMirrored } from "../src/sync/engine";

describe("provenance markers", () => {
  test("withProvenance appends marker after body", () => {
    const result = withProvenance("aone", "EXT-123", "Issue body");
    expect(result).toContain("Issue body");
    expect(result).toContain("<!-- sync:aone:EXT-123 -->");
  });

  test("withProvenance handles body ending with newline", () => {
    const result = withProvenance("aone", "EXT-456", "Body\n");
    expect(result).toBe("Body\n<!-- sync:aone:EXT-456 -->");
  });

  test("extractProvenance parses issue marker", () => {
    const p = extractProvenance("Some body\n<!-- sync:aone:EXT-789 -->");
    expect(p).toEqual({ sourceType: "aone", externalId: "EXT-789" });
  });

  test("extractProvenance returns null when no marker", () => {
    expect(extractProvenance("Plain text")).toBeNull();
  });

  test("isSyncMirrored detects matching source", () => {
    const body = withProvenance("aone", "X1", "text");
    expect(isSyncMirrored(body, "aone")).toBe(true);
    expect(isSyncMirrored(body, "gitea")).toBe(false);
  });

  test("isSyncMirrored false for native content", () => {
    expect(isSyncMirrored("Regular issue body", "aone")).toBe(false);
  });
});
