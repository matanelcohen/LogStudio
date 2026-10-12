import { describe, expect, it, vi } from "vitest";
import { askCopilot, connectCopilot } from "./api";
import { ApiRoutes, ClearActionHeader } from "./model";

describe("Copilot API", () => {
  it("requires explicit actions and only sends record IDs, questions, and bounded history", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ version: "test CLI" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "Answer #1", contextEntryCount: 1, contextTruncated: false }) });
    vi.stubGlobal("fetch", fetch);
    expect(await connectCopilot()).toBe("test CLI");
    expect(fetch.mock.calls[0]).toEqual([ApiRoutes.CopilotConnect, { method: "POST", headers: { [ClearActionHeader]: "copilot-connect" } }]);
    expect(await askCopilot("saved", [1], "Why?", [])).toEqual({ answer: "Answer #1", contextEntryCount: 1, contextTruncated: false });
    expect(fetch.mock.calls[1]?.[0]).toBe(`${ApiRoutes.CopilotChat}?sessionId=saved`);
    expect(fetch.mock.calls[1]?.[1]).toEqual({
      method: "POST", headers: { [ClearActionHeader]: "copilot-chat", "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: [1], question: "Why?", messages: [] })
    });
  });

  it("surfaces actionable failures and rejects malformed or unbounded answers", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "Run copilot login" }) });
    vi.stubGlobal("fetch", fetch);
    await expect(connectCopilot()).rejects.toThrow("Run copilot login");
    await expect(askCopilot("", [1], "Why?", [])).rejects.toThrow("Run copilot login");
    for (const data of [
      { answer: "", contextEntryCount: 1, contextTruncated: false },
      { answer: new Array(16002).join("x"), contextEntryCount: 1, contextTruncated: false },
      { answer: "answer", contextEntryCount: 101, contextTruncated: false },
      { answer: "answer", contextEntryCount: 0, contextTruncated: false },
      { answer: "answer", contextEntryCount: 1, contextTruncated: "no" }
    ]) {
      fetch.mockResolvedValue({ ok: true, json: async () => data });
      await expect(askCopilot("", [1], "Why?", [])).rejects.toThrow();
    }
  });

  it("drops oldest history pairs when Unicode would exceed the HTTP byte limit", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answer: "answer", contextEntryCount: 1, contextTruncated: false }) });
    vi.stubGlobal("fetch", fetch);
    await askCopilot("", [1], "Why?", Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant", content: "問".repeat(2000)
    })));
    const request = JSON.parse(fetch.mock.calls[0]?.[1].body ?? "{}") as { messages: unknown[] };
    expect(request.messages).toHaveLength(4);
    expect(new TextEncoder().encode(fetch.mock.calls[0]?.[1].body).length).toBeLessThanOrEqual(32768);
  });
});
