import { getDB } from "./db";
import { log } from "./logger";

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
