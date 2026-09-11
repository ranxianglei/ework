import { spawn } from "bun";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { log } from "../logger";
import type {
  RuntimeBackend,
  RuntimeSpawnOpts,
  RuntimeSpawnCallbacks,
  RuntimeHandle,
  SessionOutputResult,
  LastModelResult,
} from "./types";

export class PiBackend implements RuntimeBackend {
  readonly name = "pi";

  constructor(
    private binary: string,
    private provider: string,
    private defaultModel: string | undefined,
    private childEnvDeny: string[] = [],
  ) {}

  async spawn(opts: RuntimeSpawnOpts, cb: RuntimeSpawnCallbacks): Promise<RuntimeHandle> {
    const args: string[] = [this.binary, "--mode", "json", "--print"];

    const model = opts.model || this.defaultModel;
    if (model) {
      if (model.includes("/")) {
        const slashIdx = model.indexOf("/");
        const provider = model.slice(0, slashIdx);
        const modelId = model.slice(slashIdx + 1);
        args.push("--provider", provider, "--model", modelId);
      } else {
        args.push("--provider", this.provider, "--model", model);
      }
    } else {
      args.push("--provider", this.provider);
    }

    if (opts.resumeSessionId) {
      args.push("--session-id", opts.resumeSessionId);
    }

    args.push(opts.prompt);

    const childEnv = { ...opts.env };
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
            if (ev.type === "session" && ev.id) {
              await cb.onSessionId(ev.id as string);
              captured = true;
              break;
            }
          } catch { /* not json */ }
        }
      }
    }
  }

  async lastSessionModel(_sessionId: string | undefined): Promise<LastModelResult> {
    return { model: "" };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    return this.findSessionFile(sessionId) !== null;
  }

  async getSessionOutputTokens(sessionId: string | undefined): Promise<SessionOutputResult> {
    if (!sessionId) return { hasOutput: true, tokenCount: 0 };

    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return { hasOutput: true, tokenCount: 0 };

    try {
      const { readFileSync } = await import("fs");
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      let totalTokens = 0;
      let hasAssistant = false;

      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message" && ev.message?.role === "assistant") {
            hasAssistant = true;
            const output = ev.message?.usage?.output ?? 0;
            totalTokens += output;
          }
        } catch { /* skip */ }
      }

      return { hasOutput: hasAssistant && totalTokens > 0, tokenCount: totalTokens };
    } catch {
      return { hasOutput: true, tokenCount: 0 };
    }
  }

  private resolveSessionDir(): string {
    const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (envDir) return envDir;
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "~", ".pi", "agent");
    return join(agentDir, "sessions");
  }

  private findSessionFile(sessionId: string): string | null {
    const sessionDir = this.resolveSessionDir();
    if (!existsSync(sessionDir)) return null;
    try {
      const subdirs = readdirSync(sessionDir, { withFileTypes: true });
      for (const dir of subdirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = join(sessionDir, dir.name);
        const files = readdirSync(dirPath);
        for (const f of files) {
          if (f.includes(sessionId) && f.endsWith(".jsonl")) {
            return join(dirPath, f);
          }
        }
      }
    } catch { /* not found */ }
    return null;
  }
}
