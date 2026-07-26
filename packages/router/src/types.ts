export interface DaemonInfo {
  id: number;
  displayName: string;
  endpoint: string;
  capacity: number;
  lastHeartbeat: string;
  status: string;
  activeSessions: number;
}

export interface RouteContext {
  eventType: string;
  repository?: { owner?: string; name?: string };
  issue?: { number?: number; title?: string };
  comment?: { id?: number; body?: string };
  raw: unknown;
}

export interface RouteDecision {
  daemon: DaemonInfo | null;
  reason: string;
  candidates: DaemonInfo[];
}

export interface ReplyPayload {
  originalEventId?: string;
  targetEndpoint?: string;
  issueNumber?: number;
  repository?: { owner?: string; name?: string };
  body: string;
  raw: unknown;
}
