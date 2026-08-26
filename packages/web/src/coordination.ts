import { getDB } from "./db";
import { log } from "./logger";
import { loadConfig } from "./config";

export interface DaemonInfo {
  id: number;
  displayName: string;
  endpoint: string;
}

export interface DaemonDetail {
  id: number;
  displayName: string;
  endpoint: string;
  capacity: number;
  lastHeartbeat: string | null;
  status: string;
  registeredAt: string | null;
}

const HEARTBEAT_STALE_MS = 120_000;

// Split-UID deployments keep the daemon registry in the daemon's own SQLite
// DB, unreachable (and table-absent) from the web process — the \{\{d_*\}\}
// queries then fail and every lookup silently degrades to "no daemons".
// Fall back to the router's registry API, which holds the same rows and is
// the natural source of truth when web and daemon share no database.
interface RouterDaemonRow {
  id: number;
  displayName: string;
  endpoint: string;
  capacity: number;
  lastHeartbeat: string;
  status: string;
}

let routerCache: { at: number; rows: RouterDaemonRow[] } | null = null;

async function routerDaemons(): Promise<RouterDaemonRow[]> {
  if (routerCache && Date.now() - routerCache.at < 15_000) return routerCache.rows;
  try {
    const cfg = await loadConfig();
    if (!cfg.daemonWebhookUrl) return [];
    const res = await fetch(`${cfg.daemonWebhookUrl.replace(/\/$/, "")}/api/daemons`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { daemons?: Array<Partial<RouterDaemonRow>> };
    const rows: RouterDaemonRow[] = (data.daemons ?? [])
      .filter((d): d is Partial<RouterDaemonRow> & { id: number; endpoint: string } =>
        typeof d.id === "number" && typeof d.endpoint === "string")
      .map((d) => ({
        id: d.id,
        displayName: typeof d.displayName === "string" ? d.displayName : `daemon-${d.id}`,
        endpoint: d.endpoint,
        capacity: typeof d.capacity === "number" ? d.capacity : 0,
        lastHeartbeat: typeof d.lastHeartbeat === "string" ? d.lastHeartbeat : "",
        status: typeof d.status === "string" ? d.status : "unknown",
      }));
    routerCache = { at: Date.now(), rows };
    return rows;
  } catch (e) {
    log.info(`coordination: router registry fallback failed (${e instanceof Error ? e.message : String(e)})`);
    return [];
  }
}

export async function getActiveDaemons(): Promise<DaemonInfo[]> {
  const stale = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const staleStr = stale.toISOString().slice(0, 19).replace("T", " ");
  try {
    const rows = await getDB().all<{ id: number; display_name: string; internal_endpoint: string }>(
      `SELECT id, display_name, internal_endpoint FROM {{d_daemons}} WHERE status = 'active' AND last_heartbeat > ?`,
      [staleStr],
    );
    return rows
      .filter((r): r is { id: number; display_name: string; internal_endpoint: string } =>
        r.internal_endpoint !== null && r.internal_endpoint !== undefined && r.internal_endpoint !== "")
      .map((r) => ({
        id: r.id,
        displayName: r.display_name ?? `daemon-${r.id}`,
        endpoint: r.internal_endpoint,
      }));
  } catch (e) {
    log.info(`coordination: query failed (${e instanceof Error ? e.message : String(e)}) — assuming single-machine`);
    return [];
  }
}

export async function listAllDaemons(): Promise<DaemonDetail[]> {
  try {
    const rows = await getDB().all<{
      id: number;
      display_name: string | null;
      internal_endpoint: string;
      capacity: number | null;
      last_heartbeat: string | null;
      status: string | null;
      registered_at: string | null;
    }>(
      `SELECT id, display_name, internal_endpoint, capacity, last_heartbeat, status, registered_at FROM {{d_daemons}} ORDER BY id`,
    );
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name ?? `daemon-${r.id}`,
      endpoint: r.internal_endpoint,
      capacity: r.capacity ?? 0,
      lastHeartbeat: r.last_heartbeat,
      status: r.status ?? "unknown",
      registeredAt: r.registered_at,
    }));
  } catch (e) {
    log.info(`coordination: list daemons failed (${e instanceof Error ? e.message : String(e)})`);
    return [];
  }
}

export interface SessionDaemonInfo {
  daemonId: number;
  displayName: string;
  endpoint: string;
}

export interface SessionUidInfo {
  daemonId: number;
  opencodeSessionId: string | null;
}

export async function resolveSessionUid(uid: string): Promise<SessionUidInfo | null> {
  try {
    const rows = await getDB().all<{ daemon_id: number; opencode_session_id: string | null }>(
      `SELECT i.owner_daemon_id AS daemon_id, s.opencode_session_id
       FROM {{d_op_sessions}} s
       JOIN {{d_issues}} i ON i.uid = s.issue_id
       WHERE s.uid = ?
       LIMIT 1`,
      [uid],
    );
    const r = rows[0];
    if (!r || !r.daemon_id) return null;
    return { daemonId: r.daemon_id, opencodeSessionId: r.opencode_session_id && r.opencode_session_id !== "" ? r.opencode_session_id : null };
  } catch (e) {
    log.info(`coordination: session uid resolve failed (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

export async function getSessionDaemonMap(): Promise<Map<string, SessionDaemonInfo>> {
  try {
    const rows = await getDB().all<{
      opencode_session_id: string;
      daemon_id: number;
      display_name: string | null;
      internal_endpoint: string | null;
    }>(
      `SELECT s.opencode_session_id, d.id AS daemon_id, d.display_name, d.internal_endpoint
       FROM {{d_op_sessions}} s
       JOIN {{d_issues}} i ON i.uid = s.issue_id
       LEFT JOIN {{d_daemons}} d ON d.id = i.owner_daemon_id
       WHERE s.opencode_session_id IS NOT NULL AND s.opencode_session_id != ''`,
    );
    const map = new Map<string, SessionDaemonInfo>();
    for (const r of rows) {
      map.set(r.opencode_session_id, {
        daemonId: r.daemon_id,
        displayName: r.display_name ?? `daemon-${r.daemon_id}`,
        endpoint: r.internal_endpoint ?? "",
      });
    }
    return map;
  } catch (e) {
    log.info(`coordination: session-daemon map failed (${e instanceof Error ? e.message : String(e)})`);
    return new Map();
  }
}

export async function resolveDaemonEndpoint(daemonId: number): Promise<string | null> {
  try {
    const local = await getDB().all<{ internal_endpoint: string }>(
      "SELECT internal_endpoint FROM {{d_daemons}} WHERE id = ? LIMIT 1",
      [daemonId],
    );
    const ep = local[0]?.internal_endpoint;
    if (ep) return ep;
  } catch (e) {
    log.info(`coordination: local daemon lookup failed (${e instanceof Error ? e.message : String(e)})`);
  }
  const row = (await routerDaemons()).find((d) => d.id === daemonId);
  return row ? row.endpoint : null;
}


export interface RunningSessionInfo {
  issueNumber: string;
  sessionId: string;
  daemonId: number;
}

/**
 * Query daemon DB for sessions with state='running' belonging to a specific project scope.
 * Uses REAL daemon session state instead of the display-only ai_status field.
 */
export async function getRunningSessionsForProject(scopeKey: string): Promise<RunningSessionInfo[]> {
  try {
    const rows = await getDB().all<{
      tracker_issue_id: string;
      opencode_session_id: string;
      daemon_id: number;
    }>(
      `SELECT i.tracker_issue_id, s.opencode_session_id, i.owner_daemon_id AS daemon_id
       FROM {{d_op_sessions}} s
       JOIN {{d_issues}} i ON i.uid = s.issue_id
       WHERE s.state = 'running'
         AND i.tracker_scope_key = ?
         AND s.opencode_session_id IS NOT NULL`,
      [scopeKey],
    );
    return rows.map((r) => ({
      issueNumber: r.tracker_issue_id,
      sessionId: r.opencode_session_id,
      daemonId: r.daemon_id,
    }));
  } catch (e) {
    log.info(`coordination: running-sessions query failed (${e instanceof Error ? e.message : String(e)})`);
    return [];
  }
}
