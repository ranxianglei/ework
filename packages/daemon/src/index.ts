import { loadConfig } from "./config";
import { GiteaClient } from "./gitea";
import { Store } from "./op";
import { createServer } from "./server";
import { Engine } from "./opencode";
import { log } from "./logger";
import { GiteaTracker } from "./trackers/gitea-tracker";
import type { IssueTracker } from "./trackers/types";
import { initDB } from "./db";
import { hostname } from "os";
import * as fs from "node:fs";
import * as path from "node:path";

const config = loadConfig();
const isTest = config.env === "test";

log.info(`ework-daemon starting [${config.env}]...`);
log.info(`  gitea: ${config.gitea.url}`);
log.info(`  listen: ${config.daemon.host}:${config.daemon.port}`);
log.info(`  opencode: ${config.opencode.binary}`);
log.info(`  workdir: ${config.opencode.baseWorkdir}`);
log.info(`  db: ${config.db.driver === "mysql" ? `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.name}` : config.db.path}${config.db.prefix ? ` (prefix=${config.db.prefix})` : ""}`);
log.info(`  work: capacity=${config.work.capacity} heartbeat=${config.work.heartbeatMs}ms leaseTtl=${config.work.leaseTtlMs}ms`);

function probePlugin() {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "/tmp", ".config");
  const cfgPath = path.join(configDir, "opencode", "opencode.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw);
    const plugin = parsed.plugin ?? parsed.plugins;
    const plugins = Array.isArray(plugin) ? plugin : plugin ? [plugin] : [];
    const hasEwork = plugins.some((p: unknown) =>
      typeof p === "string" ? p.includes("opencode-ework") : false,
    );
    if (!hasEwork) {
      log.warn("  ⚠️ opencode-ework plugin not found in opencode.json — the AI will lack the 'reply' tool and all nudges will fail. Install it: npm install -g opencode-ework");
    }
  } catch {
    log.warn(`  ⚠️ could not read opencode config at ${cfgPath} — cannot verify opencode-ework plugin is installed`);
  }
}
probePlugin();

const giteaClient = new GiteaClient(config.gitea, config.bot.token);
const giteaTracker = new GiteaTracker(
  giteaClient,
  config.gitea.url,
  config.gitea.webhookSecret,
  config.bot.username
);

const trackers = new Map<string, IssueTracker>();
trackers.set("gitea", giteaTracker);

async function boot() {
  await initDB();

  const store = new Store();

  // Multi-machine coordination boot:
  // 1. Release any stale owners (dead-daemon cleanup) so we can adopt orphans.
  // 2. Register this daemon (adopts an orphan slot if available).
  // 3. First-boot migration: claim all pre-existing ownerless issues.
  await store.releaseDeadOwners(config.work.leaseTtlMs);
  const displayName = hostname();
  const internalEndpoint = config.daemon.endpoint || `${config.daemon.host}:${config.daemon.port}`;
  const daemonId = await store.registerDaemon(displayName, internalEndpoint, config.work.capacity, config.work.leaseTtlMs);
  const absorbed = await store.absorbSameHostDaemons(daemonId, displayName, internalEndpoint);
  const claimed = await store.claimAllOwnerless(daemonId);
  log.info(`  daemon registered: id=${daemonId} (adopted orphan slot if id was reused)`);
  if (absorbed > 0) log.info(`  restart recovery: absorbed ${absorbed} issue(s) from previous incarnation`);
  if (claimed > 0) log.info(`  first-boot migration: claimed ${claimed} previously-ownerless issue(s)`);

  const engine = new Engine(config, store, trackers, { daemonId });
  engine.restorePausedState();
  engine.startHeartbeat(config.work.heartbeatMs);
  const server = createServer(config, store, engine, trackers);

  async function shutdown(signal: string) {
    log.info(`\n${signal} received, shutting down...`);
    engine.destroy();
    // Best-effort: mark this daemon drained so peers don't wait for lease expiry.
    try { await store.markDaemonStatus(daemonId, "drained"); } catch { /* best-effort */ }
    await store.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection (continuing):", reason);
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException (continuing):", err);
  });

  const activeCount = (await store.listActiveIssues()).length;
  log.info(`\n${isTest ? "🧪" : "✅"} ework-daemon ready at http://${server.hostname}:${server.port}/webhook`);
  log.info(`   Configure Gitea webhook to POST to /webhook/gitea`);
  log.info(`   Active issues: ${activeCount}`);
}

void boot().catch((err) => {
  log.error("boot failed:", err);
  process.exit(1);
});
