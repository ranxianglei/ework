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
    endpoint: z.string().default(""),
  }),
  opencode: z.object({
    binary: z.string().default("opencode"),
    baseWorkdir: z.string().default(
      `${process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")}/ework-aio/opencode-workdir`
    ),
    dbPath: z.string().default(
      `${process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")}/opencode/opencode.db`
    ),
    defaultModel: z.string().default(""),
  }),
  pi: z.object({
    binary: z.string().default("pi"),
    provider: z.string().default("bailian"),
    defaultModel: z.string().default(""),
  }).optional(),
  runtime: z.enum(["opencode", "pi"]).default("opencode"),
  work: z.object({
    capacity: z.coerce.number().int().positive().default(4),
    maxConcurrent: z.coerce.number().int().positive().default(4),
    heartbeatMs: z.coerce.number().int().positive().default(10_000),
    leaseTtlMs: z.coerce.number().int().positive().default(60_000),
  }),
  db: z.object({
    driver: z.enum(["sqlite", "mysql"]).default("sqlite"),
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().default(3306),
    user: z.string().default("ework-daemon"),
    password: z.string().default(""),
    name: z.string().default("ework-daemon"),
    path: z.string(),
    prefix: z.string().default(""),
    skipCreate: z.boolean().default(false),
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
  file: z.object({
    roots: z.array(z.string()).default([]),
    maxLines: z.coerce.number().int().positive().default(2000),
    maxBytes: z.coerce.number().int().positive().default(524288),
  }).default({ roots: [], maxLines: 2000, maxBytes: 524288 }),
  childEnvDeny: z.array(z.string()).default([]),
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
  daemon: { port: 3111, host: "0.0.0.0", endpoint: "" },
  opencode: { binary: "opencode", baseWorkdir: join(tmpdir(), "ework-daemon-test"), defaultModel: "" },
  work: { capacity: 4, heartbeatMs: 10_000, leaseTtlMs: 60_000 },
  db: { path: join(process.cwd(), "test", "ework-daemon-test.db") },
};

function readWorkSection() {
  const capacity = process.env.WORK_DAEMON_CAPACITY ? Number(process.env.WORK_DAEMON_CAPACITY) : 4;
  return {
    capacity,
    maxConcurrent: process.env.WORK_MAX_CONCURRENT ? Number(process.env.WORK_MAX_CONCURRENT) : capacity,
    heartbeatMs: process.env.WORK_DAEMON_HEARTBEAT_MS ? Number(process.env.WORK_DAEMON_HEARTBEAT_MS) : 10_000,
    leaseTtlMs: process.env.WORK_DAEMON_LEASE_TTL_MS ? Number(process.env.WORK_DAEMON_LEASE_TTL_MS) : 60_000,
  };
}

function readDbSection(fallbackPath: string) {
  const driver = (process.env.WORK_DB_DRIVER ?? "sqlite").trim().toLowerCase();
  return {
    driver: (driver === "mysql" ? "mysql" : "sqlite") as "sqlite" | "mysql",
    host: process.env.WORK_DB_HOST ?? "127.0.0.1",
    port: process.env.WORK_DB_PORT ? Number(process.env.WORK_DB_PORT) : 3306,
    user: process.env.WORK_DB_USER ?? "ework-daemon",
    password: process.env.WORK_DB_PASSWORD ?? "",
    name: process.env.WORK_DB_NAME ?? "ework-daemon",
    path: process.env.WORK_DB_PATH ?? process.env.DAEMON_DB_PATH ?? fallbackPath,
    prefix: process.env.WORK_DB_PREFIX ?? "",
    skipCreate: process.env.WORK_DB_SKIP_CREATE === "1" || process.env.WORK_DB_SKIP_CREATE === "true",
  };
}

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
        endpoint: process.env.DAEMON_ENDPOINT ?? "",
      },
      opencode: {
        binary: process.env.OPENCODE_BINARY ?? TEST_DEFAULTS.opencode.binary,
        baseWorkdir: process.env.OPENCODE_BASE_WORKDIR ?? TEST_DEFAULTS.opencode.baseWorkdir,
        dbPath: process.env.OPENCODE_DB_PATH ?? `${process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")}/opencode/opencode.db`,
        defaultModel: process.env.WORK_DEFAULT_MODEL ?? TEST_DEFAULTS.opencode.defaultModel,
      },
      pi: {
        binary: process.env.WORK_PI_BINARY ?? "pi",
        provider: process.env.WORK_PI_PROVIDER ?? "bailian",
        defaultModel: process.env.WORK_PI_DEFAULT_MODEL ?? process.env.WORK_DEFAULT_MODEL ?? "",
      },
      runtime: (process.env.WORK_RUNTIME ?? "opencode").trim().toLowerCase() as "opencode" | "pi",
      work: readWorkSection(),
      db: readDbSection(TEST_DEFAULTS.db.path),
      completionCheck: process.env.COMPLETION_CHECK_API_KEY ? {
        apiKey: process.env.COMPLETION_CHECK_API_KEY,
        baseURL: process.env.COMPLETION_CHECK_BASE_URL ?? "",
        model: process.env.COMPLETION_CHECK_MODEL ?? "",
      } : undefined,
      stuck: process.env.DAEMON_STUCK_THRESHOLD_MS || process.env.DAEMON_MAX_STUCK_NUDGES ? {
        thresholdMs: Number(process.env.DAEMON_STUCK_THRESHOLD_MS) || 30 * 60 * 1000,
        maxNudges: Number(process.env.DAEMON_MAX_STUCK_NUDGES) || 1,
      } : undefined,
      childEnvDeny: (process.env.WORK_CHILD_ENV_DENY ?? "").split(",").map((s) => s.trim()).filter(Boolean),
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
      endpoint: process.env.DAEMON_ENDPOINT ?? "",
    },
    opencode: {
      binary: process.env.OPENCODE_BINARY ?? "opencode",
      baseWorkdir: process.env.OPENCODE_BASE_WORKDIR,
      dbPath: process.env.OPENCODE_DB_PATH ?? `${process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")}/opencode/opencode.db`,
      defaultModel: process.env.WORK_DEFAULT_MODEL ?? "",
    },
    pi: {
      binary: process.env.WORK_PI_BINARY ?? "pi",
      provider: process.env.WORK_PI_PROVIDER ?? "bailian",
      defaultModel: process.env.WORK_PI_DEFAULT_MODEL ?? process.env.WORK_DEFAULT_MODEL ?? "",
    },
    runtime: (process.env.WORK_RUNTIME ?? "opencode").trim().toLowerCase() as "opencode" | "pi",
    work: readWorkSection(),
    db: readDbSection(PRODUCTION_DB_DEFAULT),
    completionCheck: process.env.COMPLETION_CHECK_API_KEY ? {
      apiKey: process.env.COMPLETION_CHECK_API_KEY,
      baseURL: process.env.COMPLETION_CHECK_BASE_URL ?? "",
      model: process.env.COMPLETION_CHECK_MODEL ?? "",
    } : undefined,
    stuck: process.env.DAEMON_STUCK_THRESHOLD_MS || process.env.DAEMON_MAX_STUCK_NUDGES ? {
      thresholdMs: Number(process.env.DAEMON_STUCK_THRESHOLD_MS) || 30 * 60 * 1000,
      maxNudges: Number(process.env.DAEMON_MAX_STUCK_NUDGES) || 1,
    } : undefined,
    file: {
      roots: (process.env.WORK_FILE_ROOTS ?? "").split(":").filter(Boolean).length > 0
        ? (process.env.WORK_FILE_ROOTS ?? "").split(":").filter(Boolean)
        : [process.env.OPENCODE_BASE_WORKDIR].filter(Boolean) as string[],
      maxLines: Number(process.env.WORK_FILE_MAX_LINES) || 2000,
      maxBytes: Number(process.env.WORK_FILE_MAX_BYTES) || 524288,
    },
    childEnvDeny: (process.env.WORK_CHILD_ENV_DENY ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
}
