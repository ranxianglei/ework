import { describe, expect, test } from "bun:test";
import { rewriteRelativeRefs } from "../src/fileview";

describe("rewriteRelativeRefs", () => {
  test("rewrites relative img src to /file/raw with resolved path", () => {
    const html = `<p><img src="figures/fig1.png" alt="x"></p>`;
    const out = rewriteRelativeRefs(html, "/home/dog/p/doc.md");
    expect(out).toContain(`src="/file/raw?path=${encodeURIComponent("/home/dog/p/figures/fig1.png")}"`);
  });

  test("rewrites relative link href to /file browse url", () => {
    const html = `<a href="notes/todo.md">todo</a>`;
    const out = rewriteRelativeRefs(html, "/home/dog/p/doc.md");
    expect(out).toContain(`href="/file?path=${encodeURIComponent("/home/dog/p/notes/todo.md")}"`);
  });

  test("leaves absolute, scheme, anchor and data refs untouched", () => {
    const html = `<img src="/attachments/a.png"><img src="https://x/y.png"><a href="#sec">s</a><img src="data:image/png;base64,xx">`;
    expect(rewriteRelativeRefs(html, "/d")).toBe(html);
  });

  test("does not touch refs inside link text or code blocks", () => {
    const html = `<pre><code>[x](figures/y.png)</code></pre>`;
    expect(rewriteRelativeRefs(html, "/d")).toBe(html);
  });
});
