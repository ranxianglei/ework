import { describe, expect, test } from "bun:test";
import { piEventsToExport } from "../src/pi-sessions";
import type { PiEvent } from "../src/pi-sessions";
import { renderBatchHTML, buildSessionViewFromData } from "../src/views/sessionLog";

const EVENTS: PiEvent[] = [
  { type: "session", cwd: "/tmp/wd", timestamp: "2026-08-23T10:00:00.000Z" },
  {
    type: "message",
    timestamp: "2026-08-23T10:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "帮我看看 acp 循环" }] },
  },
  {
    type: "message",
    timestamp: "2026-08-23T10:00:02.000Z",
    message: {
      role: "assistant",
      model: "glm-4.6",
      usage: { input: 1200, output: 80, cacheRead: 3000 },
      content: [
        { type: "thinking", thinking: "先查日志" },
        { type: "text", text: "开始排查" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "grep loop *.log" } },
      ],
    },
  },
  {
    type: "message",
    timestamp: "2026-08-23T10:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "found 3 loops" }] },
  },
  {
    type: "message",
    timestamp: "2026-08-23T10:00:04.000Z",
    message: { role: "toolResult", toolCallId: "call_missing", toolName: "reply", isError: true, content: [{ type: "text", text: "boom" }] },
  },
  {
    type: "message",
    timestamp: "2026-08-23T10:00:05.000Z",
    message: {
      role: "assistant",
      model: "glm-4.6",
      usage: { input: 1200, output: 80, cacheRead: 3000 },
      content: [
        { type: "thinking", thinking: "先查日志" },
        { type: "text", text: "开始排查" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "grep loop *.log" } },
      ],
    },
  },
];

describe("piEventsToExport", () => {
  const ex = piEventsToExport("01a028fd-0000-0000-0000-000000000000", EVENTS);

  test("maps session info, title from first user text, pi version", () => {
    expect(ex.info.version).toBe("pi");
    expect(ex.info.directory).toBe("/tmp/wd");
    expect(ex.info.title).toBe("帮我看看 acp 循环");
    expect(ex.info.id).toBe("01a028fd-0000-0000-0000-000000000000");
  });

  test("assistant message: reasoning/text/tool parts + tokens mapping", () => {
    const a = ex.messages.find(m => m.info.modelID === "glm-4.6")!;
    expect(a.parts.map(p => p.type)).toEqual(["reasoning", "text", "tool"]);
    expect(a.info.modelID).toBe("glm-4.6");
    expect(a.info.tokens?.input).toBe(1200);
    expect(a.info.tokens?.cache?.read).toBe(3000);
  });

  test("tool result pairs by toolCallId into state.input/output", () => {
    const a = ex.messages.find(m => m.info.modelID === "glm-4.6")!;
    const tool = a.parts.find(p => p.type === "tool")!;
    expect(tool.state?.input).toEqual({ cmd: "grep loop *.log" });
    expect(tool.state?.output).toBe("found 3 loops");
  });

  test("orphan toolResult becomes its own assistant tool message, error marked", () => {
    const orphan = ex.messages.find(m => m.parts.some(p => p.tool === "reply"));
    expect(orphan).toBeDefined();
    const part = orphan!.parts.find(p => p.tool === "reply")!;
    expect(part.state?.output).toBe("boom");
    expect(part.state?.title).toBe("reply (error)");
  });

  test("verbatim re-emitted assistant message collapses to one", () => {
    const modelMsgs = ex.messages.filter(m => m.info.modelID === "glm-4.6");
    expect(modelMsgs).toHaveLength(1);
  });

  test("converted export renders through the shared opencode viewer", () => {
    const page = buildSessionViewFromData(ex, { desc: false, collapseLines: 12, limit: 50 });
    expect(page.html).toContain("msg-a");
    expect(page.html).toContain("🥧 pi");
    const batch = renderBatchHTML(ex, 0, 10, false, 12);
    expect(batch.total).toBeGreaterThan(0);
    expect(batch.html).toContain("msg-a");
  });
});
