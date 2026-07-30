import { Database } from "bun:sqlite";
import { openSync, closeSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Read-only OpenCode session accessor. Mirrors the subset of ework-web's
// OpencodeClient that the session pages need: list + export. The daemon
// serves this via HTTP so remote web instances can proxy session data
// without sharing a filesystem.

export interface SessionListItem {
  id: string;
  title: string;
  created: number;
  updated: number;
  directory?: string;
  peakTokens?: number;
  msgCount?: number;
}

export class OpencodeReader {
  private readonly bin: string;
  private readonly dbPath: string;
  private readonly timeoutMs = 30_000;

  constructor(bin: string, dbPath: string) {
    this.bin = bin;
    this.dbPath = dbPath;
  }

  async listSessions(limit: number): Promise<SessionListItem[]> {
    let db: Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return [];
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
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  async exportSession(id: string): Promise<unknown> {
    try {
      const fromDB = this.exportSessionFromDB(id);
      if (fromDB) return fromDB;
    } catch {
      // DB read failed (schema drift, locked, etc.) — fall back to CLI
    }
    const raw = await this.runJSON(["export", id]);
    return raw;
  }

  private exportSessionFromDB(id: string): unknown | null {
    let db: Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return null;
    }
    try {
      const srow = db
        .prepare("SELECT id, title, directory, version, time_created, time_updated FROM session WHERE id = ?")
        .get(id) as { id: string; title: string; directory: string; version: string; time_created: number; time_updated: number } | null;
      if (!srow) return null;

      const mrows = db
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
        .all(id) as Array<{ id: string; data: string }>;
      const prows = db
        .prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id")
        .all(id) as Array<{ message_id: string; data: string }>;

      const partsByMsg = new Map<string, unknown[]>();
      for (const p of prows) {
        let pd: unknown;
        try { pd = JSON.parse(p.data); } catch { continue; }
        if (!pd || typeof pd !== "object") continue;
        const arr = partsByMsg.get(p.message_id);
        if (arr) arr.push(pd); else partsByMsg.set(p.message_id, [pd]);
      }

      const messages: unknown[] = [];
      for (const m of mrows) {
        let md: Record<string, unknown>;
        try { md = JSON.parse(m.data); } catch { continue; }
        const info: Record<string, unknown> = { id: m.id, role: md.role };
        if (md.agent) info.agent = md.agent;
        const modelID = typeof md.modelID === "string" ? md.modelID : (typeof md.model === "string" ? md.model : undefined);
        if (modelID) info.modelID = modelID;
        const tRaw = md.time && typeof md.time === "object" ? (md.time as Record<string, unknown>) : null;
        if (tRaw && typeof tRaw.created === "number") info.time = { created: tRaw.created };
        if (md.tokens) info.tokens = md.tokens;
        messages.push({ info, parts: partsByMsg.get(m.id) ?? [] });
      }

      return {
        info: {
          id: srow.id,
          title: srow.title || "(untitled)",
          directory: srow.directory ?? "",
          version: srow.version ?? "",
          time: { created: srow.time_created, updated: srow.time_updated },
        },
        messages,
      };
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  async exportSessionRaw(id: string): Promise<string> {
    const { stdout, code } = await this.run(["export", id]);
    if (code !== 0) {
      throw new Error(`opencode export ${id} → exit ${code}`);
    }
    return stdout;
  }

  private async runJSON(args: string[]): Promise<unknown> {
    const { stdout, code, stderr } = await this.run(args);
    if (code !== 0) {
      const why = stderr.trim() || `exit ${code}`;
      const status = /not found|no such/i.test(why) ? 404 : 502;
      throw new OpencodeReaderError(`opencode ${args.join(" ")} failed: ${why}`, status);
    }
    const text = stdout.trim();
    if (!text) return null;
    const jsonText = stripNonJsonPreamble(text);
    if (jsonText === null) {
      throw new OpencodeReaderError(`opencode ${args.join(" ")}: non-JSON output`, 502);
    }
    try {
      return JSON.parse(jsonText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new OpencodeReaderError(`opencode ${args.join(" ")}: malformed JSON (${msg})`, 502);
    }
  }

  private async run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const tmp = join(tmpdir(), `ocd-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const fd = openSync(tmp, "w");
    const proc = Bun.spawn([this.bin, ...args], {
      stdout: fd,
      stderr: "pipe",
      env: process.env,
    });
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
      } catch { /* temp file gone */ }
    }
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    return { stdout, stderr, code };
  }
}

export class OpencodeReaderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpencodeReaderError";
    this.status = status;
  }
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > cap) {
          chunks.push(value.slice(0, cap - (total - value.length)));
          break;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function stripNonJsonPreamble(s: string): string | null {
  const i = s.indexOf("[");
  const j = s.indexOf("{");
  if (i === -1 && j === -1) return null;
  if (i === -1) return s.slice(j);
  if (j === -1) return s.slice(i);
  return s.slice(Math.min(i, j));
}
