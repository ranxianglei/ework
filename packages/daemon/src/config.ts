import { z } from "zod";
import { join } from "path";
import { tmpdir, homedir } from "os";

export type DaemonEnv = "test" | "production";

export function getEnv(): DaemonEnv {
  const v = process.env.DAEMON_ENV;
  if (v === "production" || v === "prod") return "production";
  return "test"; // default
}

export const configSchema = z.object({
  env: z.enum(["test", "production"]),
  gitea: z.object({
    url: z.string(),
    token: z.string(),
    webhookSecret: z.string().default(""),
  }),
  bot: z.object({
    username: z.string(),
    token: z.string(),
  }),
  daemon: z.object({
    port: z.coerce.number().default(3101),
    host: z.string().default("0.0.0.0"),
  }),
  opencode: z.object({
    binary: z.string().default("opencode"),
    baseWorkdir: z.string(),
  }),
  db: z.object({
    path: z.string(),
  }),
  completionCheck: z.object({
    apiKey: z.string(),
    baseURL: z.string(),
    model: z.string(),
  }).optional(),
  stuck: z.object({
    thresholdMs: z.coerce.number().positive(),
    maxNudges: z.coerce.number().int().nonnegative(),
  }).optional(),
});

export type Config = z.infer<typeof configSchema>;

const PRODUCTION_DB_DEFAULT = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "ework-daemon",
  "ework-daemon.db"
);

const TEST_DEFAULTS = {
  gitea: { url: "http://localhost:9999", token: "test-token", webhookSecret: "" },
  bot: { username: "ework-daemon-test", token: "test-bot-token" },
  daemon: { port: 3111, host: "0.0.0.0" },
  opencode: { binary: "opencode", baseWorkdir: join(tmpdir(), "ework-daemon-test") },
  db: { path: join(process.cwd(), "test", "ework-daemon-test.db") },
};

export function loadConfig(): Config {
  const env = getEnv();

  if (env === "test") {
    // Test mode: use .env.test if present, otherwise defaults.
    // Never fall through to .env (production values).
    return configSchema.parse({
      env,
      gitea: {
        url: process.env.GITEA_URL ?? TEST_DEFAULTS.gitea.url,
        token: process.env.GITEA_TOKEN ?? TEST_DEFAULTS.gitea.token,
        webhookSecret: process.env.GITEA_WEBHOOK_SECRET ?? "",
      },
      bot: {
        username: process.env.BOT_USERNAME ?? TEST_DEFAULTS.bot.username,
        token: process.env.BOT_TOKEN ?? TEST_DEFAULTS.bot.token,
      },
      daemon: {
        port: process.env.DAEMON_PORT ?? TEST_DEFAULTS.daemon.port,
        host: process.env.DAEMON_HOST ?? TEST_DEFAULTS.daemon.host,
      },
      opencode: {
        binary: process.env.OPENCODE_BINARY ?? TEST_DEFAULTS.opencode.binary,
        baseWorkdir: process.env.OPENCODE_BASE_WORKDIR ?? TEST_DEFAULTS.opencode.baseWorkdir,
      },
      db: {
        path: process.env.DAEMON_DB_PATH ?? TEST_DEFAULTS.db.path,
      },
      completionCheck: process.env.COMPLETION_CHECK_API_KEY ? {
        apiKey: process.env.COMPLETION_CHECK_API_KEY,
        baseURL: process.env.COMPLETION_CHECK_BASE_URL ?? "",
        model: process.env.COMPLETION_CHECK_MODEL ?? "",
      } : undefined,
      stuck: process.env.DAEMON_STUCK_THRESHOLD_MS || process.env.DAEMON_MAX_STUCK_NUDGES ? {
        thresholdMs: Number(process.env.DAEMON_STUCK_THRESHOLD_MS) || 30 * 60 * 1000,
        maxNudges: Number(process.env.DAEMON_MAX_STUCK_NUDGES) || 1,
      } : undefined,
    });
  }

  return configSchema.parse({
    env,
    gitea: {
      url: process.env.GITEA_URL,
      token: process.env.GITEA_TOKEN,
      webhookSecret: process.env.GITEA_WEBHOOK_SECRET ?? "",
    },
    bot: {
      username: process.env.BOT_USERNAME,
      token: process.env.BOT_TOKEN,
    },
    daemon: {
      port: process.env.DAEMON_PORT ?? 3101,
      host: process.env.DAEMON_HOST ?? "0.0.0.0",
    },
    opencode: {
      binary: process.env.OPENCODE_BINARY ?? "opencode",
      baseWorkdir: process.env.OPENCODE_BASE_WORKDIR,
    },
    db: {
      path: process.env.DAEMON_DB_PATH ?? PRODUCTION_DB_DEFAULT,
    },
    completionCheck: process.env.COMPLETION_CHECK_API_KEY ? {
      apiKey: process.env.COMPLETION_CHECK_API_KEY,
      baseURL: process.env.COMPLETION_CHECK_BASE_URL ?? "",
      model: process.env.COMPLETION_CHECK_MODEL ?? "",
    } : undefined,
    stuck: process.env.DAEMON_STUCK_THRESHOLD_MS || process.env.DAEMON_MAX_STUCK_NUDGES ? {
      thresholdMs: Number(process.env.DAEMON_STUCK_THRESHOLD_MS) || 30 * 60 * 1000,
      maxNudges: Number(process.env.DAEMON_MAX_STUCK_NUDGES) || 1,
    } : undefined,
  });
}
