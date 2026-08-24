import { describe, expect, test } from "bun:test";
import { renderMarkdown, linkifyIssueRefs } from "../src/render/markdown";
import { upstreamRefBase } from "../src/views/issueThread";
import type { ProjectRow } from "../src/store";

const P = "/dog/test1/issues/1";

describe("linkifyIssueRefs", () => {
  test("links bare #N to same-repo issue", () => {
    const h = renderMarkdown("similar to #204, check it", "", P);
    expect(h).toContain('href="/dog/test1/issues/204"');
  });

  test("links multiple refs in one line", () => {
    const h = renderMarkdown("dup of #12 and #345", "", P);
    expect(h).toContain("/issues/12");
    expect(h).toContain("/issues/345");
  });

  test("leaves code blocks and inline code untouched", () => {
    const h = renderMarkdown("use `#204` here\n\n```\n#204\n```", "", P);
    expect(h).not.toContain("/issues/204");
  });

  test("leaves hex colors and fragments alone", () => {
    const h = renderMarkdown("#ff0000 and [a](http://x/#frag)", "", P);
    expect(h).not.toContain("/issues/");
  });

  test("adjacent to CJK text still links", () => {
    const h = renderMarkdown("类似 #204 是否", "", P);
    expect(h).toContain("/issues/204");
  });

  test("no base path = no processing", () => {
    expect(linkifyIssueRefs("see #204")).toBe("see #204");
  });
});

function proj(urls: string[]): Pick<ProjectRow, "upstream_urls"> {
  return { upstream_urls: JSON.stringify(urls) };
}

describe("upstreamRefBase", () => {
  test("git@ ssh shorthand to https web base", () => {
    expect(upstreamRefBase(proj(["git@github.com:ranxianglei/billion-context.git"]))).toBe(
      "https://github.com/ranxianglei/billion-context"
    );
  });

  test("https remote strips .git", () => {
    expect(upstreamRefBase(proj(["https://github.com/o/r.git"]))).toBe("https://github.com/o/r");
    expect(upstreamRefBase(proj(["https://gitea.example.com:3300/dog/x.git"]))).toBe(
      "https://gitea.example.com:3300/dog/x"
    );
  });

  test("ssh:// and git:// schemes", () => {
    expect(upstreamRefBase(proj(["ssh://git@github.com/o/r.git"]))).toBe("https://github.com/o/r");
    expect(upstreamRefBase(proj(["git://github.com/o/r"]))).toBe("https://github.com/o/r");
  });

  test("no upstream or junk returns null", () => {
    expect(upstreamRefBase(proj([]))).toBeNull();
    expect(upstreamRefBase(proj(["/local/path"]))).toBeNull();
  });

  test("linkify resolves against upstream base", () => {
    const h = renderMarkdown("see #204", "", "https://github.com/ranxianglei/billion-context/issues/9");
    expect(h).toContain('href="https://github.com/ranxianglei/billion-context/issues/204"');
  });
});
