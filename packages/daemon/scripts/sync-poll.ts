#!/usr/bin/env bun
import { SyncEngine } from "../src/sync/engine";
import { log } from "../src/logger";
import type { PollingTracker } from "../src/trackers/types";

const ADAPTER_PATH = process.env.SYNC_ADAPTER ?? "";
const WEB_URL = process.env.SYNC_WEB_URL ?? "http://127.0.0.1:3002";
const WEB_TOKEN = process.env.SYNC_WEB_TOKEN ?? "";
const OWNER = process.env.SYNC_OWNER ?? "";
const REPO = process.env.SYNC_REPO ?? "";
const SCOPE_JSON = process.env.SYNC_SCOPE ?? "{}";
const POLL_MS = Number(process.env.SYNC_POLL_MS ?? 30000);
const CURSOR_FILE = process.env.SYNC_CURSOR_FILE ?? `${process.env.HOME}/.local/share/ework-sync/cursors.json`;

function usage(): never {
  console.error(`Usage: SYNC_ADAPTER=./my-adapter.js SYNC_OWNER=acme SYNC_REPO=widget SYNC_WEB_TOKEN=xxx bun run scripts/sync-poll.ts

Required:
  SYNC_ADAPTER     Path to adapter module exporting a PollingTracker instance
  SYNC_OWNER       ework-web project owner
  SYNC_REPO        ework-web project repo name
  SYNC_WEB_TOKEN   ework-web bot token (PAT)

Optional:
  SYNC_WEB_URL     ework-web base URL (default: http://127.0.0.1:3002)
  SYNC_SCOPE       JSON scope object for the tracker (default: {})
  SYNC_POLL_MS     Poll interval in ms (default: 30000)
  SYNC_CURSOR_FILE Cursor persistence file (default: ~/.local/share/ework-sync/cursors.json)
`);
  process.exit(1);
}

if (!ADAPTER_PATH || !OWNER || !REPO || !WEB_TOKEN) usage();

let tracker: PollingTracker;
try {
  const mod = await import(ADAPTER_PATH);
  const exported = mod.default ?? mod.tracker ?? mod.adapter;
  if (!exported) {
    console.error(`Adapter module must export a PollingTracker instance (default export, or named "tracker"/"adapter")`);
    process.exit(1);
  }
  tracker = exported as PollingTracker;
} catch (e) {
  console.error(`Failed to load adapter from ${ADAPTER_PATH}: ${(e as Error).message}`);
  process.exit(1);
}

const scope = JSON.parse(SCOPE_JSON) as Record<string, string>;

const engine = new SyncEngine({
  tracker,
  scope,
  webUrl: WEB_URL,
  webToken: WEB_TOKEN,
  owner: OWNER,
  repo: REPO,
  pollIntervalMs: POLL_MS,
  cursorFile: CURSOR_FILE,
  botLogin: "",
});

process.on("SIGINT", () => { engine.stop(); process.exit(0); });
process.on("SIGTERM", () => { engine.stop(); process.exit(0); });

engine.start();
log.info(`sync-poll: running. Press Ctrl+C to stop.`);
