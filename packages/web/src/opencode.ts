import type { Config } from "./config";
import { Database } from "bun:sqlite";
import { openSync, closeSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// OpenCode session client — READ-ONLY. Transcript detail goes through the
// `opencode export` CLI (stable, no schema coupling); the session LIST reads the
// DB directly (read-only bun:sqlite) because `opencode session list` filters out
// recent sessions by project/version — a global SELECT is the only way to list all.
// Editing (step 2) is deferred to an isolated Docker opencode.
// NOTE: `opencode export` truncates at 64KB when stdout is a pipe, so we redirect
// it to a temp file (same workaround oclog uses).

export class OpencodeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpencodeError";
    this.status = status;
  }
}

export interface SessionListItem {
  id: string;
  title: string;
  created: number;
  updated: number;
  directory?: string;
  peakTokens?: number;
  msgCount?: number;
}

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
  version: string;
  time: { created?: number; updated?: number };
}

export interface ToolState {
  input?: unknown;
  output?: unknown;
  status?: string;
  title?: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  tool?: string;
  state?: ToolState;
}

export interface MessageTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface MessageInfo {
  role: string;
  id: string;
  agent?: string;
  modelID?: string;
  time?: { created?: number };
  tokens?: MessageTokens;
}

export interface SessionMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

export interface SessionExport {
  info: SessionInfo;
  messages: SessionMessage[];
}

export class OpencodeClient {
  private readonly bin: string;
  private readonly dbPath: string;
  private readonly timeoutMs: number;
  private readonly maxBytes = 50 * 1024 * 1024;

  constructor(cfg: Config) {
    this.bin = cfg.opencodeBin;
    this.dbPath = cfg.opencodeDbPath;
    this.timeoutMs = cfg.upstreamTimeoutMs;
  }

  // Global session list via read-only SQLite SELECT. `opencode session list` (CLI)
  // filters out recent sessions by project/version, so only a direct DB read lists
  // all. WAL mode: a read-only connection never blocks opencode's writes.
  async listSessions(limit: number): Promise<SessionListItem[]> {
    let db: Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new OpencodeError(`cannot open opencode DB (${this.dbPath}): ${msg}`, 502);
    }
    try {
      const rows = db
        .prepare(
          "SELECT s.id AS id, s.title AS title, s.time_created AS created, s.time_updated AS updated, s.directory AS directory, " +
            "m.peak AS peakTokens, m.calls AS msgCount " +
            "FROM session s LEFT JOIN (" +
            "SELECT session_id, MAX(CAST(json_extract(data,'$.tokens.input') AS INT) + CAST(json_extract(data,'$.tokens.cache.read') AS INT) + CAST(json_extract(data,'$.tokens.cache.write') AS INT)) AS peak, " +
            "COUNT(*) AS calls FROM message WHERE json_extract(data,'$.tokens.input') > 0 GROUP BY session_id" +
            ") m ON m.session_id = s.id " +
            "WHERE s.time_archived IS NULL ORDER BY s.time_updated DESC LIMIT ?"
        )
        .all(limit) as Array<{ id: unknown; title: unknown; created: unknown; updated: unknown; directory: unknown; peakTokens: unknown; msgCount: unknown }>;
      return rows
        .map((r) => {
          const id = typeof r.id === "string" ? r.id : "";
          if (!id) return null;
          return {
            id,
            title: typeof r.title === "string" && r.title ? r.title : "(untitled)",
            created: typeof r.created === "number" ? r.created : 0,
            updated: typeof r.updated === "number" ? r.updated : 0,
            directory: typeof r.directory === "string" ? r.directory : undefined,
            peakTokens: typeof r.peakTokens === "number" && r.peakTokens > 0 ? r.peakTokens : undefined,
            msgCount: typeof r.msgCount === "number" && r.msgCount > 0 ? r.msgCount : undefined,
          } as SessionListItem;
        })
        .filter((x): x is SessionListItem => x !== null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new OpencodeError(`session list query failed: ${msg}`, 502);
    } finally {
      db.close();
    }
    }

  async exportSession(id: string): Promise<SessionExport> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new OpencodeError(`bad session id: ${id}`, 400);
    }
    const raw = await this.runJSON(["export", id]);
    const exp = parseSessionExport(raw);
    if (!exp) throw new OpencodeError(`malformed export for ${id}`, 502);
    return exp;
  }

  async exportSessionRaw(id: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new OpencodeError(`bad session id: ${id}`, 400);
    }
    const { stdout, code } = await this.run(["export", id]);
    if (code !== 0) {
      throw new OpencodeError(`opencode export ${id} → exit ${code}`, 502);
    }
    return stdout;
  }

  // List available models from `opencode models`. Output is plain text — one
  // `provider/model` per line — with plugin banners (e.g. "[opencode-ework]
  // registered 5 tools: ...") on stderr. We strip any line that doesn't
  // match the `provider/model` shape, dedupe, sort. Errors (binary missing,
  // non-zero exit) return an empty array — the settings UI degrades to a
  // free-text input.
  async listModels(): Promise<string[]> {
    try {
      const { stdout, code } = await this.run(["models"]);
      if (code !== 0) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        // Provider/model shape: non-empty segments on both sides of '/',
        // alphanumeric + ._-. only. Rejects banner lines like "[omo-stable] ..."
        // (which start with '['), "Exporting session:" (no slash), empty lines.
        const m = line.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (!m) continue;
        if (seen.has(line)) continue;
        seen.add(line);
        out.push(line);
      }
      out.sort();
      return out;
    } catch {
      return [];
    }
  }

  // --- subprocess plumbing ---

  private async runJSON(args: string[]): Promise<unknown> {
    const { stdout, code, stderr } = await this.run(args);
    if (code !== 0) {
      const why = stderr.trim() || `exit ${code}`;
      const status = /not found|no such/i.test(why) ? 404 : 502;
      throw new OpencodeError(`opencode ${args.join(" ")} failed: ${why}`, status);
    }
    const text = stdout.trim();
    if (!text) return null;
    const jsonText = stripNonJsonPreamble(text);
    if (jsonText === null) {
      throw new OpencodeError(`opencode ${args.join(" ")}: non-JSON output`, 502);
    }
    try {
      return JSON.parse(jsonText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new OpencodeError(`opencode ${args.join(" ")}: malformed JSON (${msg})`, 502);
    }
  }

  private async run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    // stdout → temp file: `opencode export` truncates at 64KB when stdout is a
    // pipe (kernel pipe buffer). stderr is small (progress lines) so a pipe is fine.
    const tmp = join(tmpdir(), `ocweb-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const fd = openSync(tmp, "w");
    const proc = Bun.spawn([this.bin, ...args], {
      stdout: fd,
      stderr: "pipe",
      env: process.env,
    });
    // Kill the process if it runs too long, so a hung CLI can't stall a request.
    const killer = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, this.timeoutMs);
    let stderr = "";
    let code: number | null = null;
    try {
      stderr = await readCapped(proc.stderr, 64 * 1024);
      code = await proc.exited;
    } finally {
      clearTimeout(killer);
      try { closeSync(fd); } catch { /* already closed */ }
    }
    let stdout = "";
    if (code === 0) {
      try {
        stdout = readFileSync(tmp, "utf-8");
      } catch { /* file vanished — treat as empty */ }
      if (stdout.length > this.maxBytes) {
        try { unlinkSync(tmp); } catch { /* best-effort */ }
        throw new OpencodeError(`opencode output exceeded ${this.maxBytes} bytes`, 413);
      }
    }
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    return { stdout, stderr, code };
  }
}

export interface OpencodeClientInterface {
  listSessions(limit: number): Promise<SessionListItem[]>;
  exportSession(id: string): Promise<SessionExport>;
  exportSessionRaw(id: string): Promise<string>;
  listModels(): Promise<string[]>;
}

export class RemoteOpencodeClient implements OpencodeClientInterface {
  private readonly base: string;

  constructor(endpoint: string) {
    const trimmed = endpoint.replace(/\/$/, "");
    this.base = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  async listSessions(limit: number): Promise<SessionListItem[]> {
    const res = await fetch(`${this.base}/api/opencode/sessions?limit=${limit}`);
    if (!res.ok) throw new OpencodeError(`remote listSessions → ${res.status}`, res.status);
    return (await res.json()) as SessionListItem[];
  }

  async exportSession(id: string): Promise<SessionExport> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new OpencodeError(`bad session id: ${id}`, 400);
    const res = await fetch(`${this.base}/api/opencode/sessions/${id}/export`);
    if (!res.ok) throw new OpencodeError(`remote exportSession → ${res.status}`, res.status);
    const raw = await res.json();
    const exp = parseSessionExport(raw);
    if (!exp) throw new OpencodeError(`malformed remote export for ${id}`, 502);
    return exp;
  }

  async exportSessionRaw(id: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new OpencodeError(`bad session id: ${id}`, 400);
    const res = await fetch(`${this.base}/api/opencode/sessions/${id}/raw`);
    if (!res.ok) throw new OpencodeError(`remote exportSessionRaw → ${res.status}`, res.status);
    const data = (await res.json()) as { raw?: string };
    return data.raw ?? "";
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

export function isLocalhost(endpoint: string): boolean {
  const host = endpoint.replace(/^https?:\/\//, "").split(":")[0] ?? "";
  return /^(127\.|localhost$|0\.0\.0\.0$|::1$|\[::1\]$)/.test(host);
}

export class MultiDaemonOpencodeClient implements OpencodeClientInterface {
  private readonly clients: RemoteOpencodeClient[];

  constructor(endpoints: string[]) {
    this.clients = endpoints.map((ep) => new RemoteOpencodeClient(ep));
  }

  async listSessions(limit: number): Promise<SessionListItem[]> {
    const results = await Promise.allSettled(
      this.clients.map((c) => c.listSessions(limit)),
    );
    const all: SessionListItem[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      if (r.status === "fulfilled") {
        for (const s of r.value) {
          if (s.id && !seen.has(s.id)) {
            seen.add(s.id);
            all.push(s);
          }
        }
      }
    }
    all.sort((a, b) => b.updated - a.updated);
    return all.slice(0, limit);
  }

  async exportSession(id: string): Promise<SessionExport> {
    try {
      return await Promise.any(this.clients.map((c) => c.exportSession(id)));
    } catch {
      throw new OpencodeError(`session ${id} not found on any daemon`, 404);
    }
  }

  async exportSessionRaw(id: string): Promise<string> {
    try {
      return await Promise.any(this.clients.map((c) => c.exportSessionRaw(id)));
    } catch {
      throw new OpencodeError(`session ${id} not found on any daemon`, 404);
    }
  }

  async listModels(): Promise<string[]> {
    const results = await Promise.allSettled(
      this.clients.map((c) => c.listModels()),
    );
    const models = new Set<string>();
    for (const r of results) {
      if (r.status === "fulfilled") {
        for (const m of r.value) models.add(m);
      }
    }
    return [...models];
  }
}

export function createOpencodeClient(cfg: Config, daemonEndpoint?: string): OpencodeClientInterface {
  if (daemonEndpoint && !isLocalhost(daemonEndpoint)) {
    return new RemoteOpencodeClient(daemonEndpoint);
  }
  return new OpencodeClient(cfg);
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new OpencodeError(`opencode output exceeded ${maxBytes} bytes`, 413);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// `opencode export` (and other opencode subcommands that emit JSON) write
// status lines to stdout BEFORE the JSON payload:
//   • plugin banners via console.log: "[omo-stable] Downloading comment-checker binary..."
//   • plugin registration via console.log: "[omo-stable] ast-grep binary ready."
//   • CLI status: "Exporting session: ses_..."
//   • any other stdout-side logging from plugins
// These break JSON.parse(). Find the first line that starts a JSON object
// or array and slice from there. Returns null if no JSON-looking content.
//
// We try JSON.parse at each candidate (line starting with '{' or '[') and
// return the first one that parses — necessary because plugin banners like
// "[omo-stable] ..." also start with '[' but aren't JSON.
export function stripNonJsonPreamble(s: string): string | null {
  const lines = s.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    const candidate = lines.slice(i).join("\n");
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function parseSessionExport(v: unknown): SessionExport | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const infoRaw = o.info;
  const msgsRaw = o.messages;
  if (!infoRaw || typeof infoRaw !== "object") return null;
  const info = parseSessionInfo(infoRaw);
  if (!info) return null;
  const messages = Array.isArray(msgsRaw) ? msgsRaw.map(parseMessage).filter((x): x is SessionMessage => x !== null) : [];
  return { info, messages };
}

function parseSessionInfo(v: unknown): SessionInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return null;
  const timeRaw = o.time && typeof o.time === "object" ? (o.time as Record<string, unknown>) : {};
  return {
    id,
    title: asString(o.title) || "(untitled)",
    directory: asString(o.directory),
    version: asString(o.version),
    time: {
      created: typeof timeRaw.created === "number" ? timeRaw.created : undefined,
      updated: typeof timeRaw.updated === "number" ? timeRaw.updated : undefined,
    },
  };
}

function parseMessage(v: unknown): SessionMessage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const infoRaw = o.info && typeof o.info === "object" ? o.info : null;
  if (!infoRaw) return null;
  const info = parseMessageInfo(infoRaw);
  if (!info) return null;
  const partsRaw = Array.isArray(o.parts) ? o.parts : [];
  const parts = partsRaw.map(parsePart).filter((x): x is MessagePart => x !== null);
  return { info, parts };
}

function parseMessageInfo(v: unknown): MessageInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const role = typeof o.role === "string" ? o.role : "";
  if (!id || !role) return null;
  const modelRaw = o.model && typeof o.model === "object" ? (o.model as Record<string, unknown>) : null;
  const timeRaw = o.time && typeof o.time === "object" ? (o.time as Record<string, unknown>) : null;
  return {
    role,
    id,
    agent: typeof o.agent === "string" ? o.agent : undefined,
    modelID: modelRaw && typeof modelRaw.modelID === "string" ? modelRaw.modelID : undefined,
    time: timeRaw && typeof timeRaw.created === "number" ? { created: timeRaw.created } : undefined,
    tokens: parseTokens(o.tokens),
  };
}

function parseTokens(v: unknown): MessageTokens | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string): number | undefined =>
    typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : undefined;
  const t: MessageTokens = {};
  if (num("total") !== undefined) t.total = num("total");
  if (num("input") !== undefined) t.input = num("input");
  if (num("output") !== undefined) t.output = num("output");
  if (num("reasoning") !== undefined) t.reasoning = num("reasoning");
  const c = o.cache;
  if (c && typeof c === "object") {
    const co = c as Record<string, unknown>;
    const cr = typeof co.read === "number" && Number.isFinite(co.read as number) ? (co.read as number) : undefined;
    const cw = typeof co.write === "number" && Number.isFinite(co.write as number) ? (co.write as number) : undefined;
    if (cr !== undefined || cw !== undefined) t.cache = { read: cr, write: cw };
  }
  return Object.keys(t).length ? t : undefined;
}

function parsePart(v: unknown): MessagePart | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  if (!type) return null;
  const part: MessagePart = { type };
  if (typeof o.text === "string") part.text = o.text;
  if (typeof o.tool === "string") part.tool = o.tool;
  if (o.state && typeof o.state === "object") {
    const s = o.state as Record<string, unknown>;
    const state: ToolState = {};
    if (s.input !== undefined) state.input = s.input;
    if (s.output !== undefined) state.output = s.output;
    if (typeof s.status === "string") state.status = s.status;
    if (typeof s.title === "string") state.title = s.title;
    part.state = state;
  }
  return part;
}
