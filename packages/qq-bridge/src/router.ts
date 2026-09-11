import type { Config } from "./config";
import type { EworkClient } from "./ework";
import type { GroupMessageEvent } from "./onebot";
import type { BridgeStore } from "./db";
import type { BindingStore } from "./bindings";

export const QQ_CHAT_SYSTEM = [
  "你是 QQ 群里的即时问答助手，背后是 ework 开发平台。",
  "风格：简短直接，能用一两句话说清的就别铺开；技术问题给结论和关键理由，需要展开再展开。",
  "群里成员通过 @你 提问。你看到的多轮对话里每条 user 消息前缀了提问者的昵称，注意区分不同人。",
  "如果请求明显是需要长时间执行的开发任务（改代码、查仓库、提交 PR），不要假装去做——建议对方发「任务 <标题>」创建 issue，AI agent 会接单处理。",
  "不知道就直说，不要编造。",
].join("\n");

export function splitForQQ(text: string, maxLen = 1500): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf("。", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(remaining.slice(0, cut + 1));
    remaining = remaining.slice(cut + 1);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

const HELP_TEXT = [
  "用法：",
  "  任务 <标题> —— 新建 issue 并接单（本群已绑定时：新建并换绑到新 issue）",
  "  #<编号> <内容> —— 给指定 issue 追加内容",
  "  绑定 #<编号> —— 把本群绑定到该 issue（长记忆模式：此后发言都进这个 issue）",
  "  解绑 —— 恢复为项目模式（接收整个项目的回复）",
  "  查询 —— 列出最近 issue",
  "  @我 <问题> —— 即时问答（透明压缩长记忆，历史落盘）",
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

  async function answerChat(ev: GroupMessageEvent, question: string): Promise<void> {
    try {
      const res = await fetch(`${cfg.WORK_CHAT_URL.replace(/\/+$/, "")}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.WORK_CHAT_TOKEN ? { Authorization: `Bearer ${cfg.WORK_CHAT_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          conversation: String(ev.groupId),
          message: question,
          user: ev.nickname,
          system: QQ_CHAT_SYSTEM,
        }),
      });
      if (!res.ok) throw new Error(`chat service ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const data = (await res.json()) as { reply?: string };
      if (!data.reply) throw new Error("chat service returned no reply");
      for (const part of splitForQQ(data.reply)) {
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
      if (atBot && text && cfg.WORK_CHAT_URL) {
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
