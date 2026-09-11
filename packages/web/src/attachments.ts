// Filesystem-backed attachment storage. One file per uuid under WORK_ATTACHMENT_ROOT
// (defaults to $XDG_DATA_HOME/ework/attachments). Streamed back via Bun.file so
// large media never sits in memory.

import { mkdirSync, writeFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const ATTACHMENT_ROOT =
  process.env.WORK_ATTACHMENT_ROOT ||
  join(process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`, "ework", "attachments");

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function attachmentPath(uuid: string): string {
  return join(ATTACHMENT_ROOT, uuid);
}

export function saveAttachmentBlob(uuid: string, data: Uint8Array): string {
  mkdirSync(ATTACHMENT_ROOT, { recursive: true });
  const p = attachmentPath(uuid);
  writeFileSync(p, data);
  return p;
}

export function newAttachmentUUID(): string {
  return randomUUID();
}

type BunFile = ReturnType<typeof Bun.file>;

export function readAttachmentStream(uuid: string): { file: BunFile; size: number } | null {
  const p = attachmentPath(uuid);
  if (!existsSync(p)) return null;
  const stat = statSync(p);
  return { file: Bun.file(p) as BunFile, size: stat.size };
}

export function sniffImageContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

export function isImageContentType(ct: string): boolean {
  return ct.startsWith("image/");
}
