import { mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import type { ChatTurn } from "./context";

// Agent-style persistence: one JSONL file per conversation, one line per turn,
// append-only. The send-window offset lives in a sidecar meta file rewritten
// only on eviction (rare), so the log itself is never rewritten.
export interface StoredTurn extends ChatTurn {
  ts: string;
}

interface Meta {
  sendFrom: number;
}

function safeId(conversation: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(conversation)) return conversation;
  return "h" + createHash("sha256").update(conversation).digest("hex").slice(0, 40);
}

function validTurn(v: unknown): v is StoredTurn {
  if (typeof v !== "object" || v === null) return false;
  const t = v as { role?: unknown; content?: unknown; name?: unknown };
  return (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && (t.name === undefined || typeof t.name === "string");
}

export class ConversationStore {
  private turns = new Map<string, StoredTurn[]>();
  private meta = new Map<string, number>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
      const parsed: StoredTurn[] = [];
      for (const line of lines) {
        try {
          const v: unknown = JSON.parse(line);
          if (validTurn(v)) parsed.push(v);
        } catch {
          // torn tail line after a crash mid-append: drop it, keep the rest
        }
      }
      if (parsed.length > 0) this.turns.set(id, parsed);
      const metaFile = join(dir, f + ".meta");
      let sendFrom = 0;
      if (existsSync(metaFile)) {
        try {
          sendFrom = Math.max(0, Math.min((JSON.parse(readFileSync(metaFile, "utf8")) as Meta).sendFrom ?? 0, parsed.length - 2));
        } catch {
          sendFrom = 0;
        }
      }
      this.meta.set(id, sendFrom);
    }
  }

  history(conversation: string): StoredTurn[] {
    return this.turns.get(safeId(conversation)) ?? [];
  }

  sendFrom(conversation: string): number {
    return this.meta.get(safeId(conversation)) ?? 0;
  }

  append(conversation: string, turn: ChatTurn): void {
    const id = safeId(conversation);
    const stored: StoredTurn = { ...turn, ts: new Date().toISOString() };
    appendFileSync(join(this.dir, `${id}.jsonl`), JSON.stringify(stored) + "\n");
    const list = this.turns.get(id) ?? [];
    list.push(stored);
    this.turns.set(id, list);
  }

  setSendFrom(conversation: string, from: number): void {
    const id = safeId(conversation);
    this.meta.set(id, from);
    const metaFile = join(this.dir, `${id}.jsonl.meta`);
    const tmp = metaFile + ".tmp";
    writeFileSync(tmp, JSON.stringify({ sendFrom: from } satisfies Meta));
    renameSync(tmp, metaFile);
  }

  delete(conversation: string): boolean {
    const id = safeId(conversation);
    if (!this.turns.has(id)) return false;
    this.turns.delete(id);
    this.meta.delete(id);
    rmSync(join(this.dir, `${id}.jsonl`), { force: true });
    rmSync(join(this.dir, `${id}.jsonl.meta`), { force: true });
    return true;
  }

  list(): { conversation: string; turns: number }[] {
    return [...this.turns.entries()].map(([id, turns]) => ({ conversation: id, turns: turns.length }));
  }
}
