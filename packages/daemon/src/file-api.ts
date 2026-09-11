import { realpathSync, statSync, readFileSync, openSync, readSync, closeSync, readdirSync } from "fs";
import { isAbsolute, relative } from "path";
import type { Config } from "./config";

export class FileApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FileApiError";
    this.status = status;
  }
}

const DENY = [
  /(^|\/)\.env\b/i,
  /(^|\/)\.(ssh|gnupg|aws|config\/gitea)\b/i,
  /(id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i,
  /^\/(?:etc|proc|sys|dev|boot|root)\b/i,
  /\/\.git\/(?:config|hooks|HEAD)\b/i,
];

function validateFilePath(cfg: Config, rawPath: string): string {
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new FileApiError("path must be absolute", 400);
  }
  for (const re of DENY) if (re.test(rawPath)) {
    throw new FileApiError("denied: sensitive path", 403);
  }
  let rp: string;
  try {
    rp = realpathSync(rawPath);
  } catch {
    throw new FileApiError("file not found", 404);
  }
  for (const re of DENY) if (re.test(rp)) {
    throw new FileApiError("denied: sensitive path", 403);
  }
  const inRoot = cfg.file.roots.some((r) => {
    if (!isAbsolute(r)) return false;
    let rr: string;
    try { rr = realpathSync(r); } catch { return false; }
    const rel = relative(rr, rp);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!inRoot) throw new FileApiError("denied: outside allowlisted roots", 403);
  return rp;
}

function readSlice(path: string, start: number, len: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export function listDir(cfg: Config, rawPath: string): { path: string; entries: DirEntry[] } {
  const rp = validateFilePath(cfg, rawPath);
  let st: ReturnType<typeof statSync>;
  try { st = statSync(rp); } catch { throw new FileApiError("stat failed", 404); }
  if (!st.isDirectory()) throw new FileApiError("not a directory", 400);

  const entries = readdirSync(rp, { withFileTypes: true }).map((d) => {
    const full = `${rp}/${d.name}`;
    try {
      const s = statSync(full);
      return { name: d.name, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch {
      return { name: d.name, isDir: d.isDirectory(), size: 0, mtime: 0 };
    }
  });
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: rp, entries };
}

export interface FileContent {
  path: string;
  size: number;
  rows: { n: number; t: string }[];
  mode: "tail" | "head";
  byteCapped: boolean;
  note: string;
}

export function readFile(
  cfg: Config,
  rawPath: string,
  mode: "tail" | "head",
  order: "asc" | "desc"
): FileContent {
  const rp = validateFilePath(cfg, rawPath);
  let st: ReturnType<typeof statSync>;
  try { st = statSync(rp); } catch { throw new FileApiError("stat failed", 404); }
  if (!st.isFile()) throw new FileApiError("not a regular file", 400);

  const cap = cfg.file.maxBytes;
  let buf: Buffer;
  let byteCapped = false;
  if (st.size > cap) {
    const start = mode === "tail" ? st.size - cap : 0;
    buf = readSlice(rp, start, cap);
    byteCapped = true;
  } else {
    try { buf = readFileSync(rp); } catch (e) {
      throw new FileApiError(`read failed: ${(e as Error).message}`, 500);
    }
  }

  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) if (buf[i] === 0) {
    throw new FileApiError("binary file (not viewable as text)", 415);
  }

  const text = buf.toString("utf-8");
  let lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const totalLines = lines.length;
  const n = cfg.file.maxLines;
  let shown: string[];
  let note: string;
  let firstNum: number;

  if (byteCapped) {
    if (mode === "tail") {
      shown = lines.slice(-n);
      note = `(显示最后 ${shown.length} 行，共 ~${totalLines} 行，文件 ${st.size} 字节)`;
      firstNum = totalLines - shown.length + 1;
    } else {
      shown = lines.slice(0, n);
      note = `(显示最前 ${shown.length} 行，共 ~${totalLines} 行，文件 ${st.size} 字节)`;
      firstNum = 1;
    }
  } else {
    if (lines.length > n) {
      shown = mode === "tail" ? lines.slice(-n) : lines.slice(0, n);
      note = `(${totalLines} 行，显示 ${shown.length})`;
      firstNum = mode === "tail" ? totalLines - shown.length + 1 : 1;
    } else {
      shown = lines;
      note = "";
      firstNum = 1;
    }
  }

  let rows = shown.map((t, i) => ({ n: firstNum + i, t }));
  if (order === "desc") rows = rows.reverse();

  return { path: rp, size: st.size, rows, mode, byteCapped, note };
}

export interface FileDelta {
  rows: { n: number; t: string }[];
  size: number;
  rotated: boolean;
  capped: boolean;
}

export function readFileSince(cfg: Config, rawPath: string, afterOffset: number): FileDelta {
  if (!Number.isFinite(afterOffset) || afterOffset < 0) {
    throw new FileApiError("bad after offset", 400);
  }
  const rp = validateFilePath(cfg, rawPath);
  let st: ReturnType<typeof statSync>;
  try { st = statSync(rp); } catch { throw new FileApiError("stat failed", 404); }
  if (!st.isFile()) throw new FileApiError("not a regular file", 400);

  const size = st.size;
  if (size < afterOffset) return { rows: [], size, rotated: true, capped: false };
  if (size === afterOffset) return { rows: [], size, rotated: false, capped: false };
  const cap = cfg.file.maxBytes;
  const want = Math.min(size - afterOffset, cap);
  const buf = readSlice(rp, afterOffset, want);
  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) if (buf[i] === 0) {
    throw new FileApiError("binary file (not viewable as text)", 415);
  }
  const text = buf.toString("utf-8");
  let lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const capped = size - afterOffset >= cap;
  if (capped && lines.length > 1) lines[0] = "(…前文已截断)";
  const n = cfg.file.maxLines;
  if (lines.length > n) lines = lines.slice(-n);
  const rows = lines.map((t) => ({ n: 0, t }));
  return { rows, size, rotated: false, capped };
}
