import { spawn } from "bun";
import { Database } from "bun:sqlite";
import { log } from "../logger";
import type {
  RuntimeBackend,
  RuntimeSpawnOpts,
  RuntimeSpawnCallbacks,
  RuntimeHandle,
  SessionOutputResult,
} from "./types";

const ENV_DENY_ALWAYS = ["OPENCODE", "OPENCODE_PID", "OPENCODE_RUN_ID", "OPENCODE_PROCESS_ROLE"] as const;

export class OpencodeBackend implements RuntimeBackend {
  readonly name = "opencode";

  constructor(
    private binary: string,
    private dbPath: string,
    private childEnvDeny: string[] = [],
  ) {}

  async spawn(opts: RuntimeSpawnOpts, cb: RuntimeSpawnCallbacks): Promise<RuntimeHandle> {
    const args = [this.binary, "run", "--format", "json", "--dir", opts.workdir];

    if (opts.resumeSessionId) {
      args.push("--session", opts.resumeSessionId);
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    args.push(opts.prompt);

    const childEnv = { ...opts.env };
    if (!opts.model) delete childEnv.OPENCODE_MODEL;
    for (const key of ENV_DENY_ALWAYS) delete childEnv[key];
    for (const key of this.childEnvDeny) delete childEnv[key];

    const proc = spawn({
      cmd: args,
      cwd: opts.workdir,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    const stderrText = new Response(proc.stderr).text();

    void this.readStdout(proc, cb);

    return { pid: proc.pid, exited: proc.exited, stderrText };
  }

  private async readStdout(
    proc: ReturnType<typeof spawn>,
    cb: RuntimeSpawnCallbacks,
  ): Promise<void> {
    let captured = false;
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      cb.onOutput();

      if (!captured) {
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.sessionID) {
              await cb.onSessionId(ev.sessionID as string);
              captured = true;
              break;
            }
          } catch { /* not json */ }
        }
      }
    }
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    let db: Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return false;
    }
    try {
      const row = db.prepare("SELECT 1 FROM session WHERE id = ? LIMIT 1").get(sessionId);
      return !!row;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  async getSessionOutputTokens(sessionId: string | undefined): Promise<SessionOutputResult> {
    if (!sessionId) return { hasOutput: true, tokenCount: 0 };
    let db: Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return { hasOutput: true, tokenCount: 0 };
    }
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(data,'$.tokens.output') AS INT)), 0) AS tokens " +
        "FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'assistant'"
      ).get(sessionId) as { n: number; tokens: number } | null;
      if (!row) return { hasOutput: true, tokenCount: 0 };
      return { hasOutput: row.n > 0 && row.tokens > 0, tokenCount: row.tokens };
    } catch {
      return { hasOutput: true, tokenCount: 0 };
    } finally {
      db.close();
    }
  }
}
