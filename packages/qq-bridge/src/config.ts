import { z } from "zod";

const Schema = z.object({
  // OneBot 11 reverse-WS server: NapCat connects OUT to us here.
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("127.0.0.1"),
  ONEBOT_WS_PATH: z.string().default("/onebot/v11/ws"),
  // Shared secret NapCat sends as `Authorization: Bearer <token>` on connect.
  ONEBOT_ACCESS_TOKEN: z.string().default(""),

  // ework web (Gitea-compatible shim) — used to create issues / post comments.
  EWORK_URL: z.string().url(),
  EWORK_TOKEN: z.string().min(1),

  // ework webhook ingest (same contract as ework-mirror): web fans issue
  // comment events here so agent replies can be pushed back to the group.
  EWORK_WEBHOOK_SECRET: z.string().default(""),

  // group_id -> owner/repo mapping, optionally pinned to one issue:
  //   "123456789:ranxianglei/billion-context#7,987654321:dog/test1"
  // A `#N` suffix binds the group to that single issue (long-memory mode);
  // without it the group gets all agent replies from the whole repo.
  GROUP_MAP: z.string().min(1),

  // Runtime pin overrides written by the 绑定/解绑 commands (JSON, group -> issue).
  WORK_BINDINGS_FILE: z.string().default(""),

  // QQ user_ids allowed to dispatch AI work (comma-separated). Messages from
  // other members are logged and ignored — same trust model as the GitHub
  // side (WORK_WAKE_LOGINS): strangers never wake the AI.
  QQ_WAKE_LIST: z.string().default(""),

  // ework logins whose comments are agent replies worth forwarding to QQ.
  // The bridge's own login is always skipped (echo guard).
  AGENT_LOGINS: z.string().default("ework-daemon"),

  // The ework login this bridge posts as. Must NOT be the daemon's own login
  // (daemon ignores its own comments) and should be added to the daemon's
  // WORK_WAKE_LOGINS so curated bridge comments dispatch the AI.
  BRIDGE_LOGIN: z.string().default("qq-bridge"),

  DB_PATH: z.string().default(""),


  VERBOSE: z.coerce.boolean().default(false),

  // Deployment-specific hostnames scrubbed from outbound QQ messages.
  // Env-driven so the published package never reveals real infrastructure.
  WORK_SCRUB_HOSTS: z.string().default(""),
});

export type Config = z.infer<typeof Schema>;

export interface GroupBinding {
  groupId: number;
  owner: string;
  repo: string;
  issue?: number;
}

export function parseGroupMap(raw: string): GroupBinding[] {
  const out: GroupBinding[] = [];
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const m = /^(\d+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#(\d+))?$/.exec(item);
    if (!m?.[1] || !m[2] || !m[3]) {
      throw new Error(`invalid GROUP_MAP entry: ${item}`);
    }
    out.push(m[4] ? { groupId: Number(m[1]), owner: m[2], repo: m[3], issue: Number(m[4]) } : { groupId: Number(m[1]), owner: m[2], repo: m[3] });
  }
  if (out.length === 0) throw new Error("GROUP_MAP must define at least one group");
  return out;
}

export function parseList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function loadConfig(): Config {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid config:");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  const cfg = parsed.data;
  if (!cfg.DB_PATH) {
    cfg.DB_PATH = `${process.env.HOME ?? "/tmp"}/.ework-qq-bridge/qq-bridge.db`;
  }
  if (!cfg.WORK_BINDINGS_FILE) {
    cfg.WORK_BINDINGS_FILE = `${process.env.HOME ?? "/tmp"}/.ework-qq-bridge/bindings.json`;
  }
  return cfg;
}
