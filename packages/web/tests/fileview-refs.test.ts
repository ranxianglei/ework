import { describe, expect, test } from "bun:test";

// cfg.fileRoots gates rewriting; declare the fixture tree as a root BEFORE
// the module under test reads its config.
process.env.WORK_FILE_ROOTS = "/home/dog/p";
const { rewriteRelativeMdRefs } = await import("../src/fileview");

describe("rewriteRelativeMdRefs", () => {
  test("rewrites image refs to /file/raw with resolved path", () => {
    const md = `![图1](figures/fig1.png)`;
    const out = rewriteRelativeMdRefs(md, "/home/dog/p");
    expect(out).toContain(`](/file/raw?path=${encodeURIComponent("/home/dog/p/figures/fig1.png")})`);
  });

  test("rewrites non-media link refs to /file browse url", () => {
    const out = rewriteRelativeMdRefs(`[todo](notes/todo.md)`, "/home/dog/p");
    expect(out).toContain(`](/file?path=${encodeURIComponent("/home/dog/p/notes/todo.md")})`);
  });

  test("leaves absolute, scheme, anchor and existing /file refs untouched", () => {
    const md = `[a](/x.png) [b](https://x/y.png) [c](#sec) [d](/file?path=%2Fz)`;
    expect(rewriteRelativeMdRefs(md, "/d")).toBe(md);
  });

  test("does not rewrite inside fenced code blocks", () => {
    const md = "```\n![x](figures/y.png)\n```";
    expect(rewriteRelativeMdRefs(md, "/d")).toBe(md);
  });
});
