import { listReactionsFor } from "./store";
import type { CommentView } from "./render/components";

export const REACTION_EMOJI: Record<string, string> = {
  "+1": "👍",
  "-1": "👎",
  eyes: "👀",
  heart: "❤️",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  rocket: "🚀",
  tada: "🎉",
};

export async function hydrateReactions(views: CommentView[]): Promise<void> {
  const ids = views.map((v) => v.id);
  if (ids.length === 0) return;
  const aggs = await listReactionsFor(ids);
  const byComment = new Map<number, { e: string; n: number }[]>();
  for (const a of aggs) {
    const emoji = REACTION_EMOJI[a.content] ?? a.content;
    const arr = byComment.get(a.comment_id) ?? [];
    arr.push({ e: emoji, n: a.n });
    byComment.set(a.comment_id, arr);
  }
  for (const v of views) {
    const r = byComment.get(v.id);
    if (r && r.length > 0) v.reactions = r;
  }
}
