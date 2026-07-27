import { expect, test, describe } from "bun:test";
import { forwardToDaemon } from "../src/index";

const DEAD_PORT = 59998;

describe("forwardToDaemon — URL normalization (Bug 1 regression)", () => {
  test("prepends http:// to bare host:port endpoint", async () => {
    const result = await forwardToDaemon("192.168.10.96:3101", { test: true }, 500);
    expect(result.body).not.toContain("Invalid URL");
    expect(result.body).not.toContain("TypeError");
  });

  test("prepends http:// to bare 127.0.0.1:port", async () => {
    const result = await forwardToDaemon(`127.0.0.1:${DEAD_PORT}`, { test: true }, 500);
    expect(result.body).not.toContain("Invalid URL");
    expect(result.ok).toBe(false);
  });

  test("preserves endpoint that already has http://", async () => {
    const result = await forwardToDaemon(`http://127.0.0.1:${DEAD_PORT}`, { test: true }, 500);
    expect(result.body).not.toContain("Invalid URL");
    expect(result.ok).toBe(false);
  });

  test("preserves endpoint that already has https://", async () => {
    const result = await forwardToDaemon("https://example.com:8443", { test: true }, 500);
    expect(result.body).not.toContain("Invalid URL");
  });

  test("strips trailing slash from endpoint", async () => {
    const result = await forwardToDaemon(`http://127.0.0.1:${DEAD_PORT}/`, { test: true }, 500);
    expect(result.body).not.toContain("Invalid URL");
    expect(result.ok).toBe(false);
  });
});
