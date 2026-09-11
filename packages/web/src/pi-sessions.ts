import { readFileSync } from "fs";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import type { SessionExport, SessionMessage, MessagePart } from "./opencode";
import { buildSessionViewFromData } from "./views/sessionLog";

interface PiPart {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  id?: string;
}

interface PiMessage {
  role?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
  content?: PiPart[];
}

export interface PiEvent {
  type?: string;
  timestamp?: string;
  message?: PiMessage;
  cwd?: string;
}

function sessionsRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
}

export function findPiSessionFile(sessionId: string): string | null {
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) return null;
  const root = sessionsRoot();
  if (!existsSync(root)) return null;
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (st.isFile() && e.includes(sessionId) && e.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root, 0);
  out.sort();
  return out[out.length - 1] ?? null;
}

function outputText(m: PiMessage): string {
  const payload = (m.content ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
  if (payload) return payload;
  try { return JSON.stringify(m.content ?? ""); } catch { return ""; }
}

// pi re-emits identical message content as new events (streaming steps,
// re-persisted context, repeated tool results); each re-emission also repeats
// its usage, so collapsing repeats keeps the token stats honest.
export function piEventsToExport(sessionId: string, events: PiEvent[]): SessionExport {
  const messages: SessionMessage[] = [];
  const openTools = new Map<string, { part: MessagePart }>();
  const seen = new Set<string>();
  let cwd = "";
  let created = 0;
  let updated = 0;
  let title = "";

  const stamp = (e: PiEvent) => {
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(t)) return;
    if (!created) created = t;
    updated = Math.max(updated, t);
  };

  for (const e of events) {
    if (e.type === "session" && e.cwd) cwd = e.cwd;
    stamp(e);
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const dedupeKey = `${m.role ?? ""}\u0000${JSON.stringify(m.content ?? [])}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (m.role === "user") {
      const parts: MessagePart[] = [];
      for (const p of m.content ?? []) {
        if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text });
      }
      if (!title) {
        const first = parts.map(p => p.type === "text" ? p.text : "").join(" ").trim();
        // daemon user messages are either a long system prompt or [SYSTEM
        // FORWARD] wrappers whose header quotes the issue title
        if (first.startsWith("[SYSTEM FORWARD]")) {
          const quoted = first.match(/"([^"\n]{4,120})"/);
          if (quoted?.[1]) title = quoted[1].replace(/\s+/g, " ").slice(0, 60);
        } else if (first && first.length < 400) {
          title = first.replace(/\s+/g, " ").slice(0, 60);
        }
      }
      if (parts.length) messages.push({ info: { role: "user", id: `pi_u${messages.length}`, time: { created: updated } }, parts });
      continue;
    }

    if (m.role === "assistant") {
      const parts: MessagePart[] = [];
      for (const p of m.content ?? []) {
        if (p.type === "thinking" && p.thinking) parts.push({ type: "reasoning", text: p.thinking });
        else if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text });
        else if (p.type === "toolCall") {
          const tool: MessagePart = {
            type: "tool",
            tool: p.name ?? "tool",
            state: { title: p.name ?? "tool", input: p.arguments },
          };
          if (p.id) openTools.set(p.id, { part: tool });
          parts.push(tool);
        }
      }
      if (!parts.length) continue;
      const u = m.usage;
      messages.push({
        info: {
          role: "assistant",
          id: `pi_a${messages.length}`,
          modelID: m.model,
          time: { created: updated },
          tokens: u ? { input: u.input, output: u.output, cache: { read: u.cacheRead } } : undefined,
        },
        parts,
      });
      continue;
    }

    if (m.role === "toolResult") {
      const text = outputText(m);
      const open = m.toolCallId ? openTools.get(m.toolCallId) : undefined;
      if (open && open.part.state) {
        open.part.state.output = text;
        if (m.isError) open.part.state.title = `${open.part.state.title} (error)`;
        openTools.delete(m.toolCallId!);
      } else {
        const name = m.toolName ?? "tool";
        messages.push({
          info: { role: "assistant", id: `pi_t${messages.length}`, time: { created: updated } },
          parts: [{ type: "tool", tool: name, state: { title: m.isError ? `${name} (error)` : name, output: text } }],
        });
      }
    }
  }

  return {
    info: {
      id: sessionId,
      title: title || `pi ${sessionId.slice(0, 8)}`,
      directory: cwd,
      version: "pi",
      time: { created, updated },
    },
    messages,
  };
}

export function loadPiSessionExport(sessionId: string): SessionExport | null {
  const file = findPiSessionFile(sessionId);
  if (!file) return null;
  const events: PiEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* trailing/partial line */ }
  }
  return piEventsToExport(sessionId, events);
}

export function buildPiSessionPage(sessionId: string, limit: number, asc: boolean, collapseLines = 12): string | null {
  const data = loadPiSessionExport(sessionId);
  if (!data) return null;
  return buildSessionViewFromData(data, { desc: !asc, collapseLines, limit, all: false }).html;
}
