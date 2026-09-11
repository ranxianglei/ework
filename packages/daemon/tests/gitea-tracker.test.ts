import { describe, test, expect } from "bun:test";
import { GiteaTracker } from "../src/trackers/gitea-tracker";

function makeTracker(): GiteaTracker {
  return new GiteaTracker({} as never, "http://localhost:3300", "secret", "ework-daemon");
}

function issueOpenedPayload(opts: { cloneUrl?: string; sender?: string; model?: string; runtime?: string } = {}): string {
  const repository: Record<string, unknown> = {
    owner: { login: "acme" },
    name: "widget",
  };
  if (opts.cloneUrl !== undefined) repository.clone_url = opts.cloneUrl;
  if (opts.model !== undefined) repository.ework_model = opts.model;
  if (opts.runtime !== undefined) repository.ework_runtime = opts.runtime;
  const payload: Record<string, unknown> = {
    action: "opened",
    issue: { number: 42, title: "Bug", body: "desc", state: "open", user: { login: "alice" } },
    repository,
  };
  if (opts.sender !== undefined) payload.sender = { login: opts.sender };
  return JSON.stringify(payload);
}

function commentCreatedPayload(opts: { cloneUrl?: string; sender?: string } = {}): string {
  const repository: Record<string, unknown> = {
    owner: { login: "acme" },
    name: "widget",
  };
  if (opts.cloneUrl !== undefined) repository.clone_url = opts.cloneUrl;
  const payload: Record<string, unknown> = {
    action: "created",
    issue: { number: 42, title: "Bug", state: "open", user: { login: "alice" } },
    comment: { id: 99, body: "nice", user: { login: "bob" } },
    repository,
  };
  if (opts.sender !== undefined) payload.sender = { login: opts.sender };
  return JSON.stringify(payload);
}

describe("GiteaTracker.parseWebhookEvent — clone_url extraction", () => {
  test("extracts clone_url from repository field", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload({ cloneUrl: "https://git.example.com/acme/widget.git" }));
    expect(event).not.toBeNull();
    expect(event!.cloneUrl).toBe("https://git.example.com/acme/widget.git");
  });

  test("clone_url absent → undefined", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload());
    expect(event).not.toBeNull();
    expect(event!.cloneUrl).toBeUndefined();
  });

  test("clone_url propagated on comment_created events", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(commentCreatedPayload({ cloneUrl: "https://git.example.com/acme/widget.git" }));
    expect(event).not.toBeNull();
    expect(event!.cloneUrl).toBe("https://git.example.com/acme/widget.git");
  });
});

describe("GiteaTracker.parseWebhookEvent — sender extraction", () => {
  test("extracts sender.login from payload", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload({ sender: "charlie" }));
    expect(event).not.toBeNull();
    expect(event!.sender).toBe("charlie");
  });

  test("sender absent → undefined", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload());
    expect(event).not.toBeNull();
    expect(event!.sender).toBeUndefined();
  });

  test("sender propagated on comment_created events", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(commentCreatedPayload({ sender: "dave" }));
    expect(event).not.toBeNull();
    expect(event!.sender).toBe("dave");
  });
});

describe("GiteaTracker.parseWebhookEvent — model override", () => {
  test("extracts ework_model from repository", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload({ model: "openai/gpt-4o" }));
    expect(event).not.toBeNull();
    expect(event!.model).toBe("openai/gpt-4o");
  });

  test("empty ework_model → undefined", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload({ model: "  " }));
    expect(event).not.toBeNull();
    expect(event!.model).toBeUndefined();
  });
});

describe("GiteaTracker.parseWebhookEvent — runtime override", () => {
  test("extracts ework_runtime from repository", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload({ runtime: "pi" }));
    expect(event).not.toBeNull();
    expect(event!.runtime).toBe("pi");
  });

  test("extracts opencode runtime", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload({ runtime: "opencode" }));
    expect(event).not.toBeNull();
    expect(event!.runtime).toBe("opencode");
  });

  test("invalid ework_runtime → undefined", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload({ runtime: "codex" }));
    expect(event).not.toBeNull();
    expect(event!.runtime).toBeUndefined();
  });

  test("missing ework_runtime → undefined", () => {
    const t = makeTracker();
    const event = t.parseWebhookEvent(issueOpenedPayload());
    expect(event).not.toBeNull();
    expect(event!.runtime).toBeUndefined();
  });
});

describe("GiteaTracker.parseWebhookEvent — edge cases", () => {
  test("returns null for invalid JSON", () => {
    const t = makeTracker();
    expect(t.parseWebhookEvent("not json")).toBeNull();
  });

  test("returns null when action is missing", () => {
    const t = makeTracker();
    expect(t.parseWebhookEvent(JSON.stringify({ repository: { owner: { login: "a" }, name: "b" }, issue: { number: 1 } }))).toBeNull();
  });

  test("returns null when repository is missing", () => {
    const t = makeTracker();
    expect(t.parseWebhookEvent(JSON.stringify({ action: "opened", issue: { number: 1 } }))).toBeNull();
  });

  test("returns null when issue.number is missing", () => {
    const t = makeTracker();
    expect(t.parseWebhookEvent(JSON.stringify({ action: "opened", repository: { owner: { login: "a" }, name: "b" }, issue: { title: "x" } }))).toBeNull();
  });

  test("returns null for unknown action", () => {
    const t = makeTracker();
    const payload = JSON.stringify({
      action: "labeled",
      issue: { number: 1, title: "x", state: "open", user: { login: "a" } },
      repository: { owner: { login: "acme" }, name: "widget" },
    });
    expect(t.parseWebhookEvent(payload)).toBeNull();
  });

  test("parses issue_closed action", () => {
    const t = makeTracker();
    const payload = JSON.stringify({
      action: "closed",
      issue: { number: 42, title: "Bug", state: "closed", user: { login: "alice" } },
      repository: { owner: { login: "acme" }, name: "widget", clone_url: "https://git.example.com/acme/widget.git" },
      sender: { login: "alice" },
    });
    const event = t.parseWebhookEvent(payload);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("issue_closed");
    expect(event!.cloneUrl).toBe("https://git.example.com/acme/widget.git");
    expect(event!.sender).toBe("alice");
  });
});
