import { describe, it, expect } from "bun:test";
import { detectMention } from "../src/opencode";

describe("detectMention", () => {
  describe("accepts real mentions", () => {
    const cases: Array<[string, string]> = [
      ["@ework fix the build", "ework"],
      ["hey @tester can you help", "tester"],
      ["@张三 看一下", "张三"],
      ["start with @ework", "ework"],
    ];
    for (const [text, expected] of cases) {
      it(`extracts "${expected}" from ${JSON.stringify(text)}`, () => {
        expect(detectMention(text)).toBe(expected);
      });
    }
  });

  describe("rejects phantom mentions (ework-daemon#2)", () => {
    const scoped: Array<[string, string]> = [
      ["@types/node 装不上，报 ETARGET", "@types/node (scoped npm package)"],
      ["@babel/core is missing", "@babel/core (scoped npm package)"],
      ["@scope/pkg has a bug", "@scope/pkg (scoped npm package)"],
    ];
    for (const [text, desc] of scoped) {
      it(`returns null for ${desc}`, () => {
        expect(detectMention(text)).toBeNull();
      });
    }
    const versions: Array<[string, string]> = [
      ["upgrade to @123", "version-like @123"],
      ["@45 is the latest tag", "version-like @45"],
    ];
    for (const [text, desc] of versions) {
      it(`returns null for ${desc}`, () => {
        expect(detectMention(text)).toBeNull();
      });
    }
  });

  describe("rejects non-mention @-patterns", () => {
    const cases: Array<string> = [
      "ssh user@host.example.com",
      "git@github.com:repo.git",
      "no mention here at all",
    ];
    for (const text of cases) {
      it(`ignores ${JSON.stringify(text)}`, () => {
        expect(detectMention(text)).toBeNull();
      });
    }
  });

  describe("strips code before matching", () => {
    it("ignores @mentions inside fenced code blocks", () => {
      expect(detectMention("```\n@phantom in code\n```\n@ework real")).toBe("ework");
    });
    it("ignores @mentions inside inline code", () => {
      expect(detectMention("run `@phantom` then @ework real")).toBe("ework");
    });
  });

  it("still finds a real mention after rejecting a scoped package", () => {
    expect(detectMention("@types/node @ework fix it")).toBe("ework");
  });
});
