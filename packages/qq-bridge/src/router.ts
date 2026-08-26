import type { Config } from "./config";
import type { EworkClient } from "./ework";
import type { GroupMessageEvent } from "./onebot";
import type { BridgeStore } from "./db";
import type { BindingStore } from "./bindings";
import { buildChatMessages, chatComplete, splitForQQ, type ChatTurn } from "./chat";

const HELP_TEXT = [
  "用法：",
  "  任务 <标题> —— 新建 issue 并接单（本群已绑定时：新建并换绑到新 issue）",
  "  #<编号> <内容> —— 给指定 issue 追加内容",
  "  绑定 #<编号> —— 把本群绑定到该 issue（长记忆模式：此后发言都进这个 issue）",
  "  解绑 —— 恢复为项目模式（接收整个项目的回复）",
  "  查询 —— 列出最近 issue",
  "  @我 <问题> —— 即时问答（纯 API，不留 issue，上下文满自动清理）",
  "  （绑定后：普通发言进绑定的 issue，AI 回复自动回群）",
].join("\n");

export interface RouterDeps {
  cfg: Config;
  bindings: BindingStore;
  wakeList: Set<string>;
  ework: EworkClient;
  store: BridgeStore;
  reply(groupId: number, text: string): Promise<void>;
}

interface ParsedCommand {
  kind: "create" | "comment" | "bind" | "unbind" | "help";
  title?: string;
  number?: number;
  body?: string;
}

export function parseCommand(raw: string): ParsedCommand | null {
  const text = raw.trim();
  const stripped = text.replace(/^\[CQ:at,qq=\d+\]\s*/, "").trim();
  if (stripped === "帮助" || stripped === "help" || stripped === "查询") return { kind: "help" };
  const bind = /^绑定\s*#(\d{1,6})$/.exec(stripped) ?? /^绑定\s*#(\d{1,6})$/.exec(text);
  if (bind?.[1]) return { kind: "bind", number: Number(bind[1]) };
  if (stripped === "解绑" || stripped === "unbind") return { kind: "unbind" };
  const create = /^(?:任务|task|新任务)\s+(.+)$/i.exec(stripped) ?? /^(?:任务|task|新任务)\s+(.+)$/i.exec(text);
  if (create?.[1]) return { kind: "create", title: create[1].trim() };
  const comment = /^#(\d{1,6})\s+([\s\S]+)$/.exec(stripped) ?? /^#(\d{1,6})\s+([\s\S]+)$/.exec(text);
  if (comment?.[1] && comment[2]) return { kind: "comment", number: Number(comment[1]), body: comment[2].trim() };
  return null;
}

export function createRouter(deps: RouterDeps) {
  const { cfg, bindings, wakeList, ework, store } = deps;
  const chatHistory = new Map<number, ChatTurn[]>();

  async function answerChat(ev: GroupMessageEvent, question: string): Promise<void> {
    try {
      const turn: ChatTurn = { role: "user", name: ev.nickname, content: question };
      const history = chatHistory.get(ev.groupId) ?? [];
      const messages = buildChatMessages(history, turn, cfg.WORK_CHAT_MAX_HISTORY, cfg.WORK_CHAT_MAX_CONTEXT);
      const answer = await chatComplete(cfg.WORK_CHAT_API, cfg.WORK_CHAT_API_KEY, cfg.WORK_CHAT_MODEL, messages, cfg.WORK_CHAT_TIMEOUT_MS);
      history.push(turn, { role: "assistant", name: "bot", content: answer });
      chatHistory.set(ev.groupId, history.slice(-cfg.WORK_CHAT_MAX_HISTORY * 2));
      for (const part of splitForQQ(answer)) {
        await deps.reply(ev.groupId, part);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[qq-bridge] chat failed: ${msg}`);
      await deps.reply(ev.groupId, `❌ 问答失败：${msg}`);
    }
  }
  async function handleGroupMessage(ev: GroupMessageEvent): Promise<void> {
    if (store.seenPost(ev.postId)) return;
    const binding = bindings.resolve(ev.groupId);
    if (!binding) return;

    if (!wakeList.has(String(ev.userId))) {
      if (cfg.VERBOSE) console.log(`[qq-bridge] ignore non-whitelisted ${ev.userId} in ${ev.groupId}`);
      return;
    }

    const atBot = ev.rawMessage.includes("[CQ:at,qq=") || /^\s*(任务|task|新任务|#|绑定|解绑|帮助|help|查询)/.test(ev.rawMessage);
    const cmd = parseCommand(ev.rawMessage);
    if (!cmd) {
      const text = ev.rawMessage.replace(/\[CQ:[^\]]*\]/g, "").trim();
      if (atBot && text && cfg.WORK_CHAT_API) {
        await answerChat(ev, text);
        return;
      }
      if (binding.issue !== undefined) {
        if (text) {
          await ework.addComment(binding.owner, binding.repo, binding.issue, `> 来自 QQ 群用户 **${ev.nickname}** (${ev.userId})\n\n${text}`);
        }
        return;
      }
      if (atBot) {
        await deps.reply(ev.groupId, "本群还没绑定 issue。发「绑定 #<编号>」绑定已有任务，或「任务 <标题>」新建并自动绑定。");
        return;
      }
      if (cfg.VERBOSE) console.log(`[qq-bridge] ignore non-command message from ${ev.userId}`);
      return;
    }
    if (cmd.kind === "help") {
      await deps.reply(ev.groupId, HELP_TEXT);
      return;
    }

    const attribution = `> 来自 QQ 群用户 **${ev.nickname}** (${ev.userId})`;

    try {
      if (cmd.kind === "bind" && cmd.number !== undefined) {
        const pinned = bindings.pin(ev.groupId, cmd.number);
        if (!pinned) {
          await deps.reply(ev.groupId, "❌ 本群没有配置项目映射，无法绑定");
          return;
        }
        await deps.reply(ev.groupId, `📌 本群已绑定 ${pinned.owner}/${pinned.repo}#${cmd.number}，之后的发言都会进这个 issue`);
        return;
      }
      if (cmd.kind === "unbind") {
        const ok = bindings.unpin(ev.groupId);
        await deps.reply(ev.groupId, ok ? "↩️ 已解绑，恢复项目模式（接收整个项目的回复）" : "本群本来就没有绑定 issue");
        return;
      }
      if (cmd.kind === "create") {
        const n = await ework.createIssue(binding.owner, binding.repo, cmd.title ?? "", `${attribution}\n\n${cmd.title ?? ""}`);
        bindings.pin(ev.groupId, n);
        const swap = binding.issue !== undefined ? `（原 #${binding.issue} 已解绑）` : "（本群已绑定，长记忆模式）";
        await deps.reply(ev.groupId, `✅ 已创建 issue #${n}，AI 已接单 ${swap}`);
        return;
      }
      if (cmd.kind === "comment" && cmd.number !== undefined) {
        await ework.addComment(binding.owner, binding.repo, cmd.number, `${attribution}\n\n${cmd.body ?? ""}`);
        await deps.reply(ev.groupId, `✅ 已追加到 #${cmd.number}`);
        return;
      }
    } catch (err) {
      console.error(`[qq-bridge] ework call failed: ${err instanceof Error ? err.message : err}`);
      await deps.reply(ev.groupId, `❌ 处理失败：${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return { handleGroupMessage };
}
