#!/usr/bin/env bun

const BASE = process.env.EDAEMON_URL || "http://localhost:3101";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    console.error(`Error ${res.status}: ${body}`);
    process.exit(1);
  }
  return res.json();
}

function fmtTime(ts: number | null) {
  if (!ts) return "-";
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

function fmtState(s: string) {
  const colors: Record<string, string> = {
    active: "\x1b[32m",
    idle: "\x1b[36m",
    running: "\x1b[33m",
    closed: "\x1b[90m",
    created: "\x1b[34m",
  };
  return `${colors[s] || ""}${s}\x1b[0m`;
}

// ─── Commands ───

async function cmdStatus() {
  const data = (await api("/api/status")) as Record<string, unknown>;
  console.log("Daemon:    " + JSON.stringify(data.daemon));
  console.log("Running:   " + data.running);
  console.log("Pending:   " + data.pending);
  console.log("Processes: " + data.processes);
  console.log("Observed:  " + data.observedIssues);
  console.log("Issues:    " + data.issues);
  console.log("Sessions:  " + data.sessions);
}

async function cmdIssues() {
  const issues = (await api("/api/issues")) as Record<string, unknown>[];
  if (issues.length === 0) {
    console.log("No issues.");
    return;
  }
  for (const issue of issues) {
    const scopeKey = issue.trackerScopeKey as string;
    const issueId = issue.trackerIssueId as string;
    const state = fmtState(issue.state as string);
    console.log(`  ${state}  ${issue.trackerType}:${scopeKey}#${issueId}  "${issue.title}"  id=${issue.id}`);
  }
}

async function cmdSessions() {
  const sessions = (await api("/api/sessions")) as Record<string, unknown>[];
  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }
  for (const s of sessions) {
    const state = fmtState(s.state as string);
    const pid = s.opencodePid ? `pid=${s.opencodePid}` : "";
    const sess = s.opencodeSessionId ? `session=${(s.opencodeSessionId as string).slice(0, 8)}` : "";
    const extras = [pid, sess].filter(Boolean).join(", ");
    console.log(`  ${state}  @${s.name}  ${extras}  id=${s.id}`);
  }
}

async function cmdIssue(id: string) {
  const data = (await api(`/api/issues/${id}`)) as Record<string, unknown>;
  console.log("ID:         " + data.id);
  console.log("Tracker:    " + data.trackerType);
  console.log("Scope:      " + data.trackerScopeKey);
  console.log("Issue ID:   " + data.trackerIssueId);
  console.log("State:      " + fmtState(data.state as string));
  console.log("Title:      " + data.title);
  console.log("Created:    " + data.createdAt);
  const sessions = data.sessions as Record<string, unknown>[] | undefined;
  if (sessions && sessions.length > 0) {
    console.log("Sessions:");
    for (const s of sessions) {
      console.log(`  @${s.name}  ${fmtState(s.state as string)}  id=${s.id}`);
    }
  }
}

async function cmdSession(id: string) {
  const data = await api(`/api/sessions/${id}`) as Record<string, unknown>;
  console.log("ID:         " + data.id);
  console.log("Name:       " + data.name);
  console.log("State:      " + fmtState(data.state as string));
  console.log("Issue ID:   " + data.issueId);
  console.log("Workdir:    " + (data.workdir || "-"));
  console.log("PID:        " + (data.opencodePid || "-"));
  console.log("Session:    " + (data.opencodeSessionId || "-"));
  console.log("Created:    " + data.createdAt);
}

async function cmdSessionMessages(id: string) {
  const messages = (await api(`/api/sessions/${id}/messages`)) as Record<string, unknown>[];
  if (messages.length === 0) {
    console.log("No messages.");
    return;
  }
  for (const m of messages) {
    const status = fmtState(m.status as string);
    const preview = (m.content as string).slice(0, 60).replace(/\n/g, " ");
    console.log(`  ${status}  ${preview}...  id=${(m.id as string).slice(0, 8)}`);
  }
}

async function cmdQueue() {
  const q = (await api("/api/queue")) as Record<string, number>;
  const entries = Object.entries(q);
  if (entries.length === 0) {
    console.log("Queue empty.");
    return;
  }
  for (const [key, depth] of entries) {
    console.log(`  ${key}: ${depth}`);
  }
}

async function cmdProcesses() {
  const procs = (await api("/api/processes")) as Record<string, unknown>[];
  if (procs.length === 0) {
    console.log("No running processes.");
    return;
  }
  for (const p of procs) {
    console.log(
      `  ▶ ${p.key}  pid=${p.pid}  last=${fmtTime(p.lastOutputAt as number | null)}`
    );
  }
}

async function cmdRetry(msgId: string) {
  const res = (await api(`/api/messages/${msgId}/retry`, { method: "PATCH" })) as Record<string, unknown>;
  console.log(`Retried: ${res.ok}  id=${msgId}`);
}

async function cmdStop(key: string) {
  const res = (await api(`/api/processes/${encodeURIComponent(key)}`, { method: "DELETE" })) as Record<string, unknown>;
  console.log(`Stopped: ${res.stopped}`);
}

// ─── Main ───

function usage() {
  console.log(`Usage: ework-daemon <command> [args...]

Commands:
  status                    Daemon overview
  issues                    List all issues
  issue <id>                Show issue detail + sessions
  sessions                  List all sessions
  session <id>              Show session detail
  messages <sessionId>      Show messages for a session
  queue                     Show pending queues
  processes                 Show running processes
  retry <msgId>             Retry a failed message
  stop <key>                Kill process by runtime key

Environment:
  EDAEMON_URL  Daemon URL (default: http://localhost:3101)
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) {
  usage();
  process.exit(0);
}

const commands: Record<string, () => Promise<void>> = {
  status: cmdStatus,
  issues: cmdIssues,
  sessions: cmdSessions,
  queue: cmdQueue,
  processes: cmdProcesses,
  issue: async () => {
    if (!args[1]) { console.error("Usage: ework-daemon issue <id>"); process.exit(1); }
    await cmdIssue(args[1]);
  },
  session: async () => {
    if (!args[1]) { console.error("Usage: ework-daemon session <id>"); process.exit(1); }
    await cmdSession(args[1]);
  },
  messages: async () => {
    if (!args[1]) { console.error("Usage: ework-daemon messages <sessionId>"); process.exit(1); }
    await cmdSessionMessages(args[1]);
  },
  retry: async () => {
    if (!args[1]) { console.error("Usage: ework-daemon retry <msgId>"); process.exit(1); }
    await cmdRetry(args[1]);
  },
  stop: async () => {
    if (!args[1]) { console.error("Usage: ework-daemon stop <key>"); process.exit(1); }
    await cmdStop(args[1]);
  },
};

if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

commands[cmd]!();
