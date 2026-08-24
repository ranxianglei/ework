import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { homedir } from "os";
import { resolve as resolvePath } from "path";

const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      try {
        return hljs.highlight(code, { language }).value;
      } catch {
        return code;
      }
    },
  })
);

marked.setOptions({ gfm: true, breaks: true });

// XSS boundary: marked passes raw HTML through by default, so any body with
// <img onerror>/<script>/javascript: is stored XSS. Sanitize runs before
// linkify; the injected <a> tags have fixed hrefs over controlled tokens.
const purify = createDOMPurify(new JSDOM("").window);
const PURIFY_OPTS = {
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "link", "meta"],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|\/|\.\/|\.\.\/|#)/i,
};

export function renderMarkdown(body: string, baseDir = "", baseIssuePath = ""): string {
  const dirty = marked.parse(body ?? "");
  const html = typeof dirty === "string" ? dirty : "";
  const clean = purify.sanitize(html, PURIFY_OPTS) as unknown as string;
  return linkifyIssueRefs(linkifyAbsPaths(linkifySessionIDs(clean), baseDir), baseIssuePath);
}

// Linkify #N issue references inside rendered issue content. Only applied
// when the caller supplies the current issue's path — same-repo shorthand
// (#204) resolves against it. Skips tag interiors and existing anchors,
// same token-scanning approach as linkifySessionIDs.
export function linkifyIssueRefs(html: string, baseIssuePath = ""): string {
  if (!baseIssuePath) return html;
  const issuePath = baseIssuePath.replace(/\/+$/, "");
  let out = "";
  let inA = false;
  let inCode = false;
  const re = /(<[^>]*>)|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const tag = m[1];
      if (/^<a[\s>]/i.test(tag)) inA = true;
      else if (/^<\/a[\s>]/i.test(tag)) inA = false;
      else if (/^<pre[\s>]/i.test(tag) || /^<code[\s>]/i.test(tag)) inCode = true;
      else if (/^<\/pre[\s>]/i.test(tag) || /^<\/code[\s>]/i.test(tag)) inCode = false;
      out += tag;
    } else if (m[2] !== undefined) {
      out += inA || inCode
        ? m[2]
        : m[2].replace(/(^|[^\w#])#([1-9][0-9]{0,4})(?![0-9\w])/g, (_all, pre: string, num: string) => `${pre}<a href="${issuePath.replace(/\/issues\/\d+$/, "")}/issues/${num}">#${num}</a>`);
    }
  }
  return out;
}

// Linkify ses_ IDs in text nodes only — skips tag interiors (don't corrupt
// hrefs) and existing <a> text (don't double-wrap). Runs post-sanitize with a
// fixed /sessions/ href over an alphanumeric token: never re-sanitize it out.
export function linkifySessionIDs(html: string): string {
  let out = "";
  let inA = false;
  const re = /(<[^>]*>)|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const tag = m[1];
      if (/^<a[\s>]/i.test(tag)) inA = true;
      else if (/^<\/a[\s>]/i.test(tag)) inA = false;
      out += tag;
    } else if (m[2] !== undefined) {
      out += inA
        ? m[2]
        : m[2].replace(/ses_[0-9A-Za-z]{8,}/g, (id) => `<a href="/sessions/${id}">${id}</a>`);
    }
  }
  return out;
}

// Linkify paths in text nodes — three forms:
//  - home: ~/foo/bar  → expands ~ to os.homedir()
//  - absolute: /foo/bar (≥2 segments, existing behavior)
//  - relative: foo/bar.ext → resolved against `baseDir` (e.g. session workdir)
// `pre` is a leading boundary (start, or non-word/non-slash/non-colon) so URLs
// (http://host/path, ":" excluded) and emails aren't split. Relative paths need
// a "." (extension hint) to avoid linkifying prose like "foo/bar". Runs
// post-sanitize; the /file endpoint re-validates against fileRoots on click.
const PATH_RE = /(^|[^\w\/:])((?:~\/[\w.\-]+(?:\/[\w.\-]+)*\/?)|(?:\/[\w.\-]+(?:\/[\w.\-]+)+\/?)|(?:[\w.\-]+(?:\/[\w.\-]+)+\/?))/g;

function resolveToken(token: string, baseDir: string): string | null {
  if (token.startsWith("~")) return homedir() + token.slice(1);
  if (token.startsWith("/")) return token;
  if (!baseDir || !token.includes(".")) return null;
  return resolvePath(baseDir, token);
}

export function linkifyAbsPaths(html: string, baseDir = ""): string {
  let out = "";
  let inA = false;
  const re = /(<[^>]*>)|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const tag = m[1];
      if (/^<a[\s>]/i.test(tag)) inA = true;
      else if (/^<\/a[\s>]/i.test(tag)) inA = false;
      out += tag;
    } else if (m[2] !== undefined) {
      out += inA
        ? m[2]
        : m[2].replace(PATH_RE, (_full, pre: string, token: string) => {
            const resolved = resolveToken(token, baseDir);
            return resolved
              ? `${pre}<a href="/file?path=${encodeURIComponent(resolved)}">${token}</a>`
              : `${pre}${token}`;
          });
    }
  }
  return out;
}
