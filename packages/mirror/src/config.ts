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
