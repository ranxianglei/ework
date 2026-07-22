import { test, expect } from "bun:test";
import { stripNonJsonPreamble } from "../src/opencode";

test("stripNonJsonPreamble: returns clean JSON unchanged when no preamble", () => {
  const input = '{"info":{"id":"ses_abc"},"messages":[]}';
  expect(stripNonJsonPreamble(input)).toBe(input);
});

test("stripNonJsonPreamble: returns clean array JSON unchanged", () => {
  const input = '[{"a":1},{"b":2}]';
  expect(stripNonJsonPreamble(input)).toBe(input);
});

test("stripNonJsonPreamble: strips plugin banner + 'Exporting session:' line", () => {
  // Real output captured from `opencode export <id>` with omo-stable +
  // opencode-ework plugins registered. omo-stable uses console.log (stdout)
  // for binary-download progress, opencode-ework correctly uses console.error
  // (stderr). The CLI also emits an "Exporting session:" status line.
  // All of these break JSON.parse() if not stripped first.
  const input = [
    "[omo-stable] Downloading comment-checker binary...",
    "[omo-stable] comment-checker binary ready.",
    "[opencode-ework] registered 5 tools: issue, comments, floor, reply, search",
    "Exporting session: ses_10c5b897cffeoRygswFdCtXI7c",
    "{",
    '  "info": {',
    '    "id": "ses_10c5b897cffeoRygswFdCtXI7c",',
    '    "slug": "tidy-island"',
    "  }",
    "}",
  ].join("\n");
  const stripped = stripNonJsonPreamble(input);
  expect(stripped).not.toBeNull();
  const parsed = JSON.parse(stripped!);
  expect(parsed.info.id).toBe("ses_10c5b897cffeoRygswFdCtXI7c");
  expect(parsed.info.slug).toBe("tidy-island");
});

test("stripNonJsonPreamble: strips leading whitespace before JSON opener", () => {
  const input = "preamble line\n   {\"a\":1}";
  expect(stripNonJsonPreamble(input)).toBe('   {"a":1}');
});

test("stripNonJsonPreamble: returns null when no JSON-looking line exists", () => {
  expect(stripNonJsonPreamble("just plain text\nno json here")).toBeNull();
  expect(stripNonJsonPreamble("")).toBeNull();
});

test("stripNonJsonPreamble: ignores '[' inside non-JSON preamble banner lines", () => {
  // Plugin banners like "[omo-stable] ..." start with '[' but aren't JSON.
  // Must try JSON.parse at each candidate and skip the ones that fail.
  const input = [
    "[omo-stable] Downloading comment-checker binary...",
    "[omo-stable] comment-checker binary ready.",
    "{",
    '  "real": "json"',
    "}",
  ].join("\n");
  const stripped = stripNonJsonPreamble(input);
  expect(stripped).not.toBeNull();
  const parsed = JSON.parse(stripped!);
  expect(parsed.real).toBe("json");
});
