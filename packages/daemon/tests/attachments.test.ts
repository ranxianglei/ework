import { test, expect, beforeEach, afterEach } from "bun:test";
import { rm, readFile, stat } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadIssueAttachments,
  attachmentNote,
  MAX_ATTACHMENT_BYTES,
} from "../src/attachments";

const UUID = "96945ce4-c5c5-4000-94b6-1dd746760ac2";

let dir: string;
let calls: { url: string; headers: Record<string, string> }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "att-test-"));
  calls = [];
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

function mockFetch(status: number, headers: Record<string, string>, body: string) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(status === 302 ? null : body, {
      status,
      headers: new Headers(headers),
    });
  }) as unknown as typeof fetch;
}

test("downloads attachment with sanitized filename from content-disposition", async () => {
  mockFetch(200, {
    "content-disposition": 'attachment; filename="acp (2).log"',
    "content-length": "11",
  }, "hello log\n");
  const out = await downloadIssueAttachments(
    `[acp (2).log](/attachments/${UUID}) 看这个`,
    "http://127.0.0.1:3002/",
    "tok123",
    dir,
  );
  expect(out).toHaveLength(1);
  expect(out[0]!.filename).toBe("acp (2).log");
  expect(out[0]!.skipped).toBeUndefined();
  expect(calls[0]!.headers.authorization).toBe("token tok123");
  const saved = await readFile(join(dir, "attachments", "acp (2).log"), "utf8");
  expect(saved).toBe("hello log\n");
});

test("auth failure (302) is reported as skipped, no file written", async () => {
  mockFetch(302, { location: "/login" }, "");
  const out = await downloadIssueAttachments(
    `x (/attachments/${UUID})`,
    "http://w",
    "t",
    dir,
  );
  expect(out[0]!.skipped).toContain("302");
  await expect(stat(join(dir, "attachments"))).rejects.toThrow();
});

test("oversized attachment is skipped", async () => {
  globalThis.fetch = (async () =>
    new Response("x", {
      status: 200,
      headers: new Headers({
        "content-length": String(MAX_ATTACHMENT_BYTES + 1),
      }),
    })) as unknown as typeof fetch;
  const out = await downloadIssueAttachments(
    `(/attachments/${UUID})`,
    "http://w",
    "t",
    dir,
  );
  expect(out[0]!.skipped).toBe("too large");
});

test("no attachment links yields empty and no fetch", async () => {
  mockFetch(200, {}, "x");
  const out = await downloadIssueAttachments("plain text no links", "http://w", "t", dir);
  expect(out).toHaveLength(0);
  expect(calls).toHaveLength(0);
});

test("duplicate links in one message download once", async () => {
  mockFetch(200, { "content-disposition": 'attachment; filename="a.txt"' }, "A");
  const out = await downloadIssueAttachments(
    `see [1](/attachments/${UUID}) and again (/attachments/${UUID})`,
    "http://w",
    "t",
    dir,
  );
  expect(out).toHaveLength(1);
  expect(calls).toHaveLength(1);
});

test("attachmentNote lists files and skips", () => {
  const note = attachmentNote([
    { uuid: UUID, filename: "a.log", size: 1450120 },
    { uuid: "b", filename: "", size: 0, skipped: "HTTP 404" },
  ]);
  expect(note).toContain("attachments/a.log");
  expect(note).toContain("1416.1 KB");
  expect(note).toContain("HTTP 404");
  expect(attachmentNote([])).toBe("");
});
