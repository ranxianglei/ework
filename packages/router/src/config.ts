import { z } from "zod";

const EnvSchema = z.object({
  ROUTER_PORT: z.coerce.number().default(3102),
  ROUTER_HOST: z.string().default("0.0.0.0"),
  ROUTER_ENV: z.enum(["test", "production"]).default("test"),

  WORK_DB_DRIVER: z.enum(["sqlite", "mysql"]).default("sqlite"),
  WORK_DB_PATH: z.string().default(""),
  WORK_DB_PREFIX: z.string().default(""),
  WORK_DB_HOST: z.string().default("127.0.0.1"),
  WORK_DB_PORT: z.coerce.number().default(3306),
  WORK_DB_USER: z.string().default(""),
  WORK_DB_PASSWORD: z.string().default(""),
  WORK_DB_NAME: z.string().default("ework"),

  DAEMON_TABLE_PREFIX: z.string().default("d_"),
  ROUTER_STRATEGY: z.enum(["least-loaded", "round-robin", "first-available"]).default("least-loaded"),
  ROUTER_STALE_THRESHOLD_MS: z.coerce.number().default(120_000),
  ROUTER_FORWARD_TIMEOUT_MS: z.coerce.number().default(30_000),
  ROUTER_FALLBACK_ENDPOINT: z.string().default(""),
  ROUTER_ADMIN_TOKEN: z.string().default(""),
  ROUTER_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("config validation failed:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
