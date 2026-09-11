export interface IssueActionContext {
  owner: string;
  repo: string;
  issueNumber: number;
  state: string;
  aiStatus: string;
  viewerLogin: string;
  viewerIsAdmin: boolean;
  labels: { id: number; name: string; color: string }[];
}

export interface IssueAction {
  id: string;
  label: string;
  title?: string;
  method?: "POST" | "GET";
  href: string;
  confirm?: string;
  reloadOnOk?: boolean;
  className?: string;
}

export interface IssueActionsProvider {
  issueActions(ctx: IssueActionContext): Promise<IssueAction[]> | IssueAction[];
  statusBadges?: Record<string, { cls: string; label: string }>;
}

const hookCache = new Map<string, IssueActionsProvider | null>();

async function loadHook(hookPath: string): Promise<IssueActionsProvider | null> {
  const cached = hookCache.get(hookPath);
  if (cached !== undefined) return cached;

  try {
    const path = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const abs = path.isAbsolute(hookPath) ? hookPath : path.resolve(process.cwd(), hookPath);
    const mod = await import(pathToFileURL(abs).href);
    const provider: IssueActionsProvider = mod.default ?? mod;
    if (!provider || typeof provider.issueActions !== "function") {
      console.warn(`[issue-actions-hook] ${hookPath}: must export an object with issueActions()`);
      hookCache.set(hookPath, null);
      return null;
    }
    hookCache.set(hookPath, provider);
    return provider;
  } catch (e) {
    console.warn(`[issue-actions-hook] failed to load ${hookPath}:`, e);
    hookCache.set(hookPath, null);
    return null;
  }
}

export async function runIssueActionsHook(
  hookPath: string,
  ctx: IssueActionContext,
): Promise<{ actions: IssueAction[]; statusBadges?: Record<string, { cls: string; label: string }> }> {
  if (!hookPath) return { actions: [] };
  const provider = await loadHook(hookPath);
  if (!provider) return { actions: [] };
  try {
    const actions = await provider.issueActions(ctx);
    if (!Array.isArray(actions)) return { actions: [], statusBadges: provider.statusBadges };
    return { actions, statusBadges: provider.statusBadges };
  } catch (e) {
    console.warn(`[issue-actions-hook] ${hookPath}: issueActions() threw:`, e);
    return { actions: [] };
  }
}

export function clearIssueActionsHookCache(): void {
  hookCache.clear();
}
