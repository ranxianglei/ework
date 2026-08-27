import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatTurn } from "./chat";

// Persistent @bot chat history: group -> turns, survives restarts.
// No trimming here — set() callers must pass already-trimmed arrays
// (same trimStored policy as before), keeping the file bounded.
type HistoryFile = Record<string, ChatTurn[]>;

function validTurn(v: unknown): v is ChatTurn {
  if (typeof v !== "object" || v === null) return false;
  const t = v as { role?: unknown; content?: unknown };
  return (t.role === "user" || t.role === "assistant") && typeof t.content === "string";
}

export class ChatHistoryStore {
  private history = new Map<number, ChatTurn[]>();

  constructor(private file: string) {
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as HistoryFile;
        for (const [k, v] of Object.entries(raw)) {
          if (Number.isInteger(Number(k)) && Array.isArray(v)) {
            const turns = v.filter(validTurn);
            if (turns.length > 0) this.history.set(Number(k), turns);
          }
        }
      }
    } catch (err) {
      console.warn(`[qq-bridge] chat history file unreadable, starting clean: ${err instanceof Error ? err.message : err}`);
    }
  }

  private persist(): void {
    const out: HistoryFile = {};
    for (const [g, turns] of this.history) out[String(g)] = turns;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(out));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[qq-bridge] failed to persist chat history: ${err instanceof Error ? err.message : err}`);
    }
  }

  get(groupId: number): ChatTurn[] {
    return this.history.get(groupId) ?? [];
  }

  set(groupId: number, turns: ChatTurn[]): void {
    this.history.set(groupId, turns);
    this.persist();
  }
}
