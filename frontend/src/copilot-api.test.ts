import { describe, expect, it, vi } from "vitest";
import { askCopilot, clearCopilotHistory, connectCopilot, fetchCopilotHistory } from "./api";
import { ApiRoutes, ClearActionHeader } from "./model";

describe("Copilot API", () => {
  it("loads the complete selected transcript locally and explicitly resets it", async () => {
    const history = [1, 2, 3, 4, 5].flatMap(turn => [
      { role: "user", content: `Question ${turn}` }, { role: "assistant", content: "Full answer ".repeat(1000) }
    ]);
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(history)))
      .mockResolvedValueOnce(new Response("[]"));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await fetchCopilotHistory("saved", signal)).toEqual(history);
    expect(fetch).toHaveBeenNthCalledWith(1, `${ApiRoutes.CopilotHistory}?sessionId=saved`, { signal });
    await clearCopilotHistory("saved");
    expect(fetch).toHaveBeenNthCalledWith(2, `${ApiRoutes.CopilotHistory}?sessionId=saved`, {
      method: "POST", headers: { [ClearActionHeader]: "copilot-clear-history" }
    });
  });

  it("rejects malformed transcripts and surfaces history read/reset failures", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const history of [
      {}, [{ role: "user", content: "Incomplete" }],
      [{ role: "system", content: "Invalid" }, { role: "assistant", content: "Answer" }],
      [{ role: "user", content: 123 }, { role: "assistant", content: "Answer" }]
    ]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(history)));
      await expect(fetchCopilotHistory("", new AbortController().signal)).rejects.toThrow();
    }
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Cannot read history" }), { status: 500 }));
    await expect(fetchCopilotHistory("", new AbortController().signal)).rejects.toThrow("Cannot read history");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Cannot reset history" }), { status: 500 }));
    await expect(clearCopilotHistory("")).rejects.toThrow("Cannot reset history");
  });

  it("passes model and reasoning choices in the request, not the prompt", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answer: "answer", contextEntryCount: 1, contextTruncated: false }) });
    vi.stubGlobal("fetch", fetch);
    await askCopilot("", "Why?", [], { model: "reasoner", reasoningEffort: "high" });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      question: "Why?", messages: [], model: "reasoner", reasoningEffort: "high"
    });
  });

  it("decodes fragmented UTF-8 streaming updates and requires a final response", async () => {
    const updates = vi.fn();
    const encoded = new TextEncoder().encode([
      JSON.stringify({ content: "原因" }),
      JSON.stringify({ content: "原因 found" }),
      JSON.stringify({ answer: "原因 found", contextEntryCount: 1, contextTruncated: false }), ""
    ].join("\n"));
    const body = new ReadableStream({ start(controller) {
      for (let index = 0; index < encoded.length; index += 5) controller.enqueue(encoded.slice(index, index + 5));
      controller.close();
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })));
    expect((await askCopilot("", "Why?", [], {}, updates)).answer).toBe("原因 found");
    expect(updates.mock.calls).toEqual([["原因"], ["原因 found"]]);
  });

  it("rejects stream errors, missing completions, invalid JSON and oversized content", async () => {
    for (const frame of [
      JSON.stringify({ error: "Copilot failed" }) + "\n",
      JSON.stringify({ content: "Incomplete" }) + "\n",
      JSON.stringify({ content: "x".repeat(16001) }) + "\n",
      "{invalid json}\n"
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(frame, { headers: { "Content-Type": "application/x-ndjson" } })));
      await expect(askCopilot("", "Why?", [], {}, vi.fn())).rejects.toThrow();
    }
  });

  it("requires explicit actions and sends questions and bounded history, not visible record IDs", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ version: "test CLI", models: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "Answer #1", contextEntryCount: 1, contextTruncated: false }) });
    vi.stubGlobal("fetch", fetch);
    expect(await connectCopilot()).toEqual({ version: "test CLI", models: [] });
    expect(fetch.mock.calls[0]).toEqual([ApiRoutes.CopilotConnect, { method: "POST", headers: { [ClearActionHeader]: "copilot-connect" } }]);
    expect(await askCopilot("saved", "Why?", [])).toEqual({ answer: "Answer #1", contextEntryCount: 1, contextTruncated: false });
    expect(fetch.mock.calls[1]?.[0]).toBe(`${ApiRoutes.CopilotChat}?sessionId=saved`);
    expect(fetch.mock.calls[1]?.[1]).toEqual({
      method: "POST", headers: { [ClearActionHeader]: "copilot-chat", "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Why?", messages: [] })
    });
  });

  it("surfaces actionable failures and rejects malformed or unbounded answers", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "Run copilot login" }) });
    vi.stubGlobal("fetch", fetch);
    await expect(connectCopilot()).rejects.toThrow("Run copilot login");
    await expect(askCopilot("", "Why?", [])).rejects.toThrow("Run copilot login");
    for (const data of [
      { answer: "", contextEntryCount: 1, contextTruncated: false },
      { answer: new Array(16002).join("x"), contextEntryCount: 1, contextTruncated: false },
      { answer: "answer", contextEntryCount: -1, contextTruncated: false },
      { answer: "answer", contextEntryCount: 0, contextTruncated: false },
      { answer: "answer", contextEntryCount: 1, contextTruncated: "no" }
    ]) {
      fetch.mockResolvedValue({ ok: true, json: async () => data });
      await expect(askCopilot("", "Why?", [])).rejects.toThrow();
    }
  });

  it("drops oldest history pairs when Unicode would exceed the HTTP byte limit", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answer: "answer", contextEntryCount: 1, contextTruncated: false }) });
    vi.stubGlobal("fetch", fetch);
    await askCopilot("", "Why?", Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant", content: "問".repeat(2000)
    })));
    const request = JSON.parse(fetch.mock.calls[0]?.[1].body ?? "{}") as { messages: unknown[] };
    expect(request.messages).toHaveLength(4);
    expect(new TextEncoder().encode(fetch.mock.calls[0]?.[1].body).length).toBeLessThanOrEqual(32768);
  });

  it("accepts full-session context counts above the old visible-page limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      answer: "Full session", contextEntryCount: 30927, contextTruncated: false
    }) }));
    expect((await askCopilot("", "Why?", [])).contextEntryCount).toBe(30927);
  });
});
