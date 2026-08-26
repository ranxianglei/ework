import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function initDB(path: string): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
}

export class BridgeStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS seen_posts (
      post_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS forwarded_comments (
      comment_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  // QQ dedup: NapCat may redeliver events after reconnect; each post is
  // handled exactly once.
  seenPost(postId: string): boolean {
    const row = this.db.query("SELECT 1 FROM seen_posts WHERE post_id = ?").get(postId);
    if (row) return true;
    this.db.query("INSERT OR IGNORE INTO seen_posts (post_id) VALUES (?)").run(postId);
    return false;
  }

  // Webhook dedup: web retries deliveries; mark comment ids already pushed.
  commentForwarded(commentId: number): boolean {
    const row = this.db.query("SELECT 1 FROM forwarded_comments WHERE comment_id = ?").get(commentId);
    if (row) return true;
    this.db.query("INSERT OR IGNORE INTO forwarded_comments (comment_id) VALUES (?)").run(commentId);
    return false;
  }

  close(): void {
    this.db.close();
  }
}
