import type { ServerWebSocket } from "bun";

 type HeadersInitLike = Record<string, string>;

export interface GroupMessageEvent {
  postId: string;
  groupId: number;
  userId: number;
  nickname: string;
  rawMessage: string;
  post_type: string;
  message_type: string;
}

interface OneBotEvent {
  post_id?: number | string;
  post_type?: string;
  message_type?: string;
  group_id?: number;
  user_id?: number;
  sender?: { card?: string; nickname?: string };
  raw_message?: string;
  time?: number;
  [key: string]: unknown;
}

interface ApiRequest {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
}

interface ApiResult {
  status: string;
  retcode: number;
  data?: unknown;
}

// Public API handle: call() sends OneBot actions and waits for the echo-matched
// result; connection lifecycle is owned by the server.
export interface OneBotApi {
  call(action: string, params: Record<string, unknown>): Promise<ApiResult>;
}

export interface OneBotServerOptions {
  path: string;
  accessToken: string;
  onEvent(ev: GroupMessageEvent): void | Promise<void>;
  onReady(api: OneBotApi): void;
}

interface PendingEntry {
  resolve: (r: ApiResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createOneBotServer(opts: OneBotServerOptions) {
  const pending = new Map<string, PendingEntry>();
  let ws: ServerWebSocket<unknown> | null = null;

  function rejectAll(reason: string) {
    for (const [, entry] of pending) {
      entry.reject(new Error(reason));
    }
    pending.clear();
    ws = null;
  }

  return {
    get connected() {
      return ws !== null;
    },

    // Bun handlers: wire these into Bun.serve({websocket:{...}})
    handlers: {
      open(client: ServerWebSocket<unknown>) {
        if (ws) {
          client.close(4000, "duplicate connection");
          return;
        }
        ws = client;
        const api: OneBotApi = {
          call(action, params) {
            const echo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            return new Promise<ApiResult>((resolve, reject) => {
              const timer = setTimeout(() => {
                pending.delete(echo);
                reject(new Error(`OneBot call ${action} timed out`));
              }, 10_000);
              pending.set(echo, { resolve, reject, timer });
              const req: ApiRequest = { action, params, echo };
              client.send(JSON.stringify(req));
            });
          },
        };
        opts.onReady(api);
      },
      message(_client: ServerWebSocket<unknown>, data: string | Buffer) {
        let msg: OneBotEvent & { echo?: string; status?: string; retcode?: number; data?: unknown };
        try {
          msg = JSON.parse(String(data)) as typeof msg;
        } catch {
          return;
        }
        if (typeof msg.echo === "string" && pending.has(msg.echo)) {
          const entry = pending.get(msg.echo)!;
          pending.delete(msg.echo);
          clearTimeout(entry.timer);
          entry.resolve({ status: msg.status ?? "unknown", retcode: msg.retcode ?? -1, data: msg.data });
          return;
        }
        if (msg.post_type === "message" && msg.message_type === "group") {
          const ev: GroupMessageEvent = {
            postId: String(msg.post_id ?? `${msg.time ?? 0}-${msg.user_id ?? 0}`),
            groupId: Number(msg.group_id ?? 0),
            userId: Number(msg.user_id ?? 0),
            nickname: String(msg.sender?.card || msg.sender?.nickname || String(msg.user_id ?? "")),
            rawMessage: String(msg.raw_message ?? ""),
            post_type: "message",
            message_type: "group",
          };
          void opts.onEvent(ev);
        }
      },
      close() {
        rejectAll("connection closed");
      },
    },
  };
}
