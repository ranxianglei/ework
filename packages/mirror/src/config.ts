import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(1197),
  HOST: z.string().default("127.0.0.1"),

  EWORK_WEBHOOK_SECRET: z.string().default(""),

  GITEA_URL: z.string().url(),
  GITEA_TOKEN: z.string().min(1),

  // Load-bearing: must be `awork`. awork daemon's isBotUser() check
  // (awork/src/trackers/gitea-tracker.ts:178) skips comments authored by
  // its bot username. If this is changed to any other user, every mirrored
  // POST to Gitea will trigger an extra opencode session in awork, creating
  // duplicate AI runs on every real user action.
  GITEA_ACT_AS: z.string().default("awork"),

  DB_PATH: z.string().default(""),

  VERBOSE: z.coerce.boolean().default(false),

  // GitHub targets: comments authored by these logins are echoes imported
  // from GitHub by upstream-sync; mirroring them back would duplicate.
  SKIP_AUTHOR_LOGINS: z.string().default(""),

  // Deployment-specific hostnames scrubbed from mirrored bodies.
  // Deliberately env-driven (no defaults naming real hosts) so the
  // published package never reveals which infrastructure runs it.
  WORK_SCRUB_HOSTS: z.string().default(""),

  // Logins whose content is agent-generated. Mirrored items authored by
  // these get a visible "🤖 agent · <model>" footer so upstream readers
  // can tell AI output apart from the relaying human account.
  WORK_AGENT_LOGINS: z.string().default("ework-daemon"),
});

export type Config = z.infer<typeof Schema>;

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
    const XDG = process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`;
    cfg.DB_PATH = `${XDG}/ework-mirror/mirror.db`;
  }
  return cfg;
}

export function isGithubTarget(cfg: Config): boolean {
  try {
    return /github\.com$/i.test(new URL(cfg.GITEA_URL).host);
  } catch {
    return false;
  }
}

export function apiPrefix(cfg: Config): string {
  return isGithubTarget(cfg) ? "" : "/api/v1";
}
