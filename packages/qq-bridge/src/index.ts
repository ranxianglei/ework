import { loadConfig, parseGroupMap, parseList } from "./config";
import { BridgeStore } from "./db";
import { BindingStore } from "./bindings";
import { createOneBotServer, type OneBotApi, type GroupMessageEvent } from "./onebot";
import { createRouter } from "./router";
import { createIngest } from "./ingest";
import { createEworkClient } from "./ework";
import { buildScrubber } from "./scrub";

async function main() {
  const cfg = loadConfig();
  if (cfg.DB_PATH) {
  const dir = cfg.DB_PATH.slice(0, cfg.DB_PATH.lastIndexOf("/"));
  if (dir) await Bun.write(`${dir}/.keep`, "");
}
const store = new BridgeStore(cfg.DB_PATH || "/tmp/ework-qq-bridge.db");

  const bindings = new BindingStore(parseGroupMap(cfg.GROUP_MAP), cfg.WORK_BINDINGS_FILE);

  let api: OneBotApi | null = null;
  const send = async (groupId: number, text: string) => {
    if (!api) throw new Error("OneBot client not connected");
    await api.call("send_group_msg", { group_id: groupId, message: [{ type: "text", data: { text } }] });
  };

  const ework = createEworkClient(cfg.EWORK_URL, cfg.EWORK_TOKEN);
  const scrub = buildScrubber(parseList(cfg.WORK_SCRUB_HOSTS));
  const router = createRouter({
    cfg,
    bindings,
    wakeList: new Set(parseList(cfg.QQ_WAKE_LIST)),
    ework,
    store,
    reply: send,
  });

  const ingest = createIngest({
    secret: cfg.EWORK_WEBHOOK_SECRET,
    bridgeLogin: cfg.BRIDGE_LOGIN,
    agentLogins: new Set(parseList(cfg.AGENT_LOGINS)),
    scrub,
    groupsFor: (owner, repo, number) => bindings.groupsFor(owner, repo, number),
    commentForwarded: (id) => store.commentForwarded(id),
    send,
  });

  const server = createOneBotServer({
    path: cfg.ONEBOT_WS_PATH,
    accessToken: cfg.ONEBOT_ACCESS_TOKEN,
    onEvent: async (ev: GroupMessageEvent) => {
      await router.handleGroupMessage(ev);
    },
    onReady: (a: OneBotApi) => {
      api = a;
      console.log("[qq-bridge] OneBot client connected");
    },
  });

  Bun.serve({
    port: cfg.PORT,
    websocket: server.handlers,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname === cfg.ONEBOT_WS_PATH) {
        if (cfg.ONEBOT_ACCESS_TOKEN) {
          const auth = req.headers.get("authorization") ?? "";
          if (auth !== `Bearer ${cfg.ONEBOT_ACCESS_TOKEN}`) return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/ingest/ework") return ingest(req);
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`[qq-bridge] listening on :${cfg.PORT} (ws ${cfg.ONEBOT_WS_PATH}, ingest /ingest/ework)`);
}

main();
