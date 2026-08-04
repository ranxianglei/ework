/**
 * Example WORK_ISSUE_ACTIONS_HOOK module.
 *
 * Deploy: set WORK_ISSUE_ACTIONS_HOOK=/path/to/this/file.js
 *
 * Default export can be:
 *   - An object with issueActions(ctx) => IssueAction[]
 *   - Optionally also statusBadges for custom ai_status rendering
 *
 * IssueAction buttons use data-action-* attributes, handled by
 * /static/issue-actions.js — no custom JS needed from the hook.
 */

export default {
  async issueActions(ctx) {
    const actions = [];
    const base = `/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}`;

    if (ctx.aiStatus === "failed") {
      actions.push({
        id: "retry",
        label: "🔄 重试",
        title: "重新触发 AI 处理",
        href: `${base}/resume`,
        confirm: "确认重试？",
      });
    }

    if (ctx.viewerIsAdmin) {
      actions.push({
        id: "assign-human",
        label: "👤 转人工",
        title: "标记为需人工处理",
        href: `${base}/halt`,
        confirm: "确认转人工？",
        className: "custom-action-btn warn",
      });
    }

    return actions;
  },

  statusBadges: {
    waiting_review: { cls: "ai-waiting", label: "⏳ 待审核" },
  },
};
