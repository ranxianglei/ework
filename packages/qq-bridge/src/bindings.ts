import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { GroupBinding } from "./config";

// Runtime issue pins: group -> issue number, persisted across restarts.
// owner/repo always come from the static GROUP_MAP entry; the pin only
// narrows which single issue the group is bound to.
type PinFile = Record<string, number>;

export class BindingStore {
  private pins = new Map<number, number>();

  constructor(private base: GroupBinding[], private file: string) {
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as PinFile;
        for (const [k, v] of Object.entries(raw)) {
          if (Number.isInteger(Number(k)) && Number.isInteger(v)) {
            this.pins.set(Number(k), v);
          }
        }
      }
    } catch (err) {
      console.warn(`[qq-bridge] bindings file unreadable, starting clean: ${err instanceof Error ? err.message : err}`);
    }
  }

  private persist(): void {
    const out: PinFile = {};
    for (const [g, n] of this.pins) out[String(g)] = n;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(out, null, 2) + "\n");
    } catch (err) {
      console.error(`[qq-bridge] failed to persist bindings: ${err instanceof Error ? err.message : err}`);
    }
  }

  resolve(groupId: number): GroupBinding | null {
    const base = this.base.find((b) => b.groupId === groupId);
    if (!base) return null;
    const pinned = this.pins.get(groupId);
    if (pinned === undefined) return base;
    return { ...base, issue: pinned };
  }

  all(): GroupBinding[] {
    return this.base.map((b) => this.resolve(b.groupId)!);
  }

  groupsFor(owner: string, repo: string, issueNumber: number): number[] {
    return this.all()
      .filter((b) => b.owner === owner && b.repo === repo && (b.issue === undefined || b.issue === issueNumber))
      .map((b) => b.groupId);
  }

  pin(groupId: number, issue: number): GroupBinding | null {
    if (!this.base.some((b) => b.groupId === groupId)) return null;
    this.pins.set(groupId, issue);
    this.persist();
    return this.resolve(groupId);
  }

  unpin(groupId: number): boolean {
    if (!this.pins.delete(groupId)) return false;
    this.persist();
    return true;
  }
}
