import type { GroupBinding, Config } from "./config";
import type { EworkClient } from "./ework";
import type { GroupMessageEvent } from "./onebot";
import type { BridgeStore } from "./db";
import { buildChatMessages, chatComplete, splitForQQ, type ChatTurn } from "./chat";

const HELP_TEXT = [
  "用法：",
  "  任务 <标题> —— 新建 issue，AI 自动接单",
  "  #<编号> <内容> —— 给指定 issue 追加内容",
  "  查询 —— 列出最近 issue",
  "  @我 + 任意问题 —— 即时问答（不建 issue）",
].join("\n");

export interface RouterDeps {
  cfg: Config;
  bindings: GroupBinding[];
  wakeList: Set<string>;
  ework: EworkClient;
  store: BridgeStore;
  reply(groupId: number, text: string): Promise<void>;
}

interface ParsedCommand {
  kind: "create" | "comment" | "help";
  title?: string;
  number?: number;
  body?: string;
}

export function parseCommand(raw: string): ParsedCommand | null {
  const text = raw.trim();
  const stripped = text.replace(/^\[CQ:at,qq=\d+\]\s*/, "").trim();
  if (stripped === "帮助" || stripped === "help" || stripped === "查询") return { kind: "help" };
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
    const turn: ChatTurn = { role: "user", name: ev.nickname, content: question };
    const history = chatHistory.get(ev.groupId) ?? [];
    const messages = buildChatMessages(history, turn, cfg.WORK_CHAT_MAX_HISTORY);
    const answer = await chatComplete(cfg.WORK_CHAT_API, cfg.WORK_CHAT_API_KEY, cfg.WORK_CHAT_MODEL, messages, cfg.WORK_CHAT_TIMEOUT_MS);
    history.push(turn, { role: "assistant", name: "bot", content: answer });
    if (history.length > cfg.WORK_CHAT_MAX_HISTORY * 2) {
      chatHistory.set(ev.groupId, history.slice(-cfg.WORK_CHAT_MAX_HISTORY * 2));
    } else {
      chatHistory.set(ev.groupId, history);
    }
    for (const part of splitForQQ(answer)) {
      await deps.reply(ev.groupId, part);
    }
  }

  async function handleGroupMessage(ev: GroupMessageEvent): Promise<void> {
    if (store.seenPost(ev.postId)) return;
    const binding = bindings.find((b) => b.groupId === ev.groupId);
    if (!binding) return;

    if (!wakeList.has(String(ev.userId))) {
      if (cfg.VERBOSE) console.log(`[qq-bridge] ignore non-whitelisted ${ev.userId} in ${ev.groupId}`);
      return;
    }

    const atBot = ev.rawMessage.includes("[CQ:at,qq=") || /^\s*(任务|task|新任务|#|帮助|help|查询)/.test(ev.rawMessage);
    const cmd = parseCommand(ev.rawMessage);
    if (!cmd && !atBot) {
      if (cfg.VERBOSE) console.log(`[qq-bridge] unrecognized message from ${ev.userId}: ${ev.rawMessage.slice(0, 80)}`);
      return;
    }
    if (!cmd) {
      const question = ev.rawMessage.replace(/\[CQ:[^\]]*\]/g, "").trim();
      if (cfg.WORK_CHAT_API && question) {
        try {
          await answerChat(ev, question);
        } catch (err) {
          console.error(`[qq-bridge] chat failed: ${err instanceof Error ? err.message : err}`);
          await deps.reply(ev.groupId, "🤖 回答失败了，稍后再试一次。");
        }
        return;
      }
      await deps.reply(ev.groupId, "没看懂指令。\n" + HELP_TEXT);
      return;
    }
    if (cmd.kind === "help") {
      await deps.reply(ev.groupId, HELP_TEXT);
      return;
    }

    const attribution = `> 来自 QQ 群用户 **${ev.nickname}** (${ev.userId})`;

    try {
      if (cmd.kind === "create") {
        const n = await ework.createIssue(binding.owner, binding.repo, cmd.title ?? "", `${attribution}\n\n${cmd.title ?? ""}`);
        await deps.reply(ev.groupId, `✅ 已创建 issue #${n}，AI 已接单：${cmd.title ?? ""}`);
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
