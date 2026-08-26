import { mkdir, writeFile } from "node:fs/promises";

/**
 * ework-web attachment links: `[name](/attachments/<uuid>)` in issue bodies
 * and comments. The web requires auth on that route, but the daemon's Gitea
 * PAT is accepted (same auth surface as cookies), so the daemon downloads
 * attachments for the agent instead of teaching it to curl with tokens.
 */
export const ATTACHMENT_LINK_RE = /\/attachments\/([0-9a-fA-F-]{36})/g;

export interface DownloadedAttachment {
  uuid: string;
  filename: string;
  size: number;
  /** Reason the referenced attachment was not downloaded, if any. */
  skipped?: string;
}

export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

function sanitizeFilename(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || fallback;
}

/**
 * Download every /attachments/<uuid> referenced in `content` into
 * `<workdir>/attachments/` using the daemon's Gitea PAT. Best-effort:
 * failures are reported per-attachment via `skipped`, never thrown.
 */
export async function downloadIssueAttachments(
  content: string,
  baseUrl: string,
  token: string,
  workdir: string,
): Promise<DownloadedAttachment[]> {
  const uuids = new Set<string>();
  for (const m of content.matchAll(ATTACHMENT_LINK_RE)) {
    if (m[1]) uuids.add(m[1]);
  }
  if (uuids.size === 0) return [];
  const base = baseUrl.replace(/\/+$/, "");
  const out: DownloadedAttachment[] = [];
  for (const uuid of uuids) {
    try {
      const res = await fetch(`${base}/attachments/${uuid}`, {
        headers: { authorization: `token ${token}` },
        signal: AbortSignal.timeout(120_000),
        // Auth failures surface as 302 -> login; treat redirects as failures
        // instead of following them to the login page.
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        out.push({ uuid, filename: "", size: 0, skipped: `HTTP ${res.status} (auth)` });
        continue;
      }
      if (!res.ok) {
        out.push({ uuid, filename: "", size: 0, skipped: `HTTP ${res.status}` });
        continue;
      }
      const lenHeader = Number(res.headers.get("content-length") ?? "0");
      if (lenHeader > MAX_ATTACHMENT_BYTES) {
        out.push({ uuid, filename: "", size: lenHeader, skipped: "too large" });
        continue;
      }
      const cd = res.headers.get("content-disposition") ?? "";
      const nameMatch = cd.match(/filename="([^"]*)"/);
      const filename = sanitizeFilename(nameMatch?.[1] ?? "", `${uuid}.bin`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        out.push({ uuid, filename, size: buf.length, skipped: "too large" });
        continue;
      }
      const dir = `${workdir}/attachments`;
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/${filename}`, buf);
      out.push({ uuid, filename, size: buf.length });
    } catch (e) {
      out.push({
        uuid,
        filename: "",
        size: 0,
        skipped: e instanceof Error ? e.message : "download error",
      });
    }
  }
  return out;
}

export function attachmentNote(atts: DownloadedAttachment[]): string {
  if (atts.length === 0) return "";
  const lines = atts.map((a) =>
    a.skipped
      ? `- ${a.filename || a.uuid}: 未能下载（${a.skipped}）`
      : `- attachments/${a.filename}（${(a.size / 1024).toFixed(1)} KB）`,
  );
  return `\n\n[system] 本条消息引用的附件已由系统代为下载到工作目录的 attachments/ 目录：\n${lines.join("\n")}\n请直接用文件工具读取分析（日志类文件建议分段/grep 查看）。`;
}
