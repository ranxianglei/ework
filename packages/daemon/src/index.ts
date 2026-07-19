import { loadConfig } from "./config";
import { GiteaClient } from "./gitea";
import { Store } from "./op";
import { createServer } from "./server";
import { Engine } from "./opencode";
import { log } from "./logger";
import { GiteaTracker } from "./trackers/gitea-tracker";
import type { IssueTracker } from "./trackers/types";

const config = loadConfig();
const isTest = config.env === "test";

log.info(`ework-daemon starting [${config.env}]...`);
log.info(`  gitea: ${config.gitea.url}`);
log.info(`  listen: ${config.daemon.host}:${config.daemon.port}`);
log.info(`  opencode: ${config.opencode.binary}`);
log.info(`  workdir: ${config.opencode.baseWorkdir}`);
log.info(`  db: ${config.db.path}`);

const giteaClient = new GiteaClient(config.gitea, config.bot.token);
const giteaTracker = new GiteaTracker(
  giteaClient,
  config.gitea.url,
  config.gitea.webhookSecret,
  config.bot.username
);

const trackers = new Map<string, IssueTracker>();
trackers.set("gitea", giteaTracker);

const store = new Store(config.db.path);
const engine = new Engine(config, store, trackers);

const server = createServer(config, store, engine, trackers);

async function shutdown(signal: string) {
  log.info(`\n${signal} received, shutting down...`);
  engine.destroy();
  store.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log.info(`\n${isTest ? "🧪" : "✅"} ework-daemon ready at http://${server.hostname}:${server.port}/webhook`);
log.info(`   Configure Gitea webhook to POST to /webhook/gitea`);
log.info(`   Active issues: ${store.listActiveIssues().length}`);
