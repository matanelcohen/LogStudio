import { describe, expect, it, vi } from "vitest";
import { deleteSession, importSessionFile, readSessionInfo, renameSession, saveSessionFilters } from "./api";
import { ClearActionHeader, defaultQuery, ImportActionValue, SaveFiltersActionValue, sessionFilters, type SessionInfo } from "./model";

const Session: SessionInfo = {
  id: "imported", name: "Imported run", startedAt: "2026-10-11T08:00:00Z",
  completedAt: null, exitCode: null, entryCount: 2, command: null,
  arguments: [], workingDirectory: "", isCurrent: false
};

class RequestStub {
  static instances: RequestStub[] = [];
  constructor() { RequestStub.instances.push(this); }
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  responseType = "";
  status = 0;
  response: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
}

describe("session transfer API", () => {
  it("uploads the File directly, sends protected action headers, and reports real progress", async () => {
    vi.stubGlobal("XMLHttpRequest", RequestStub);
    const file = new File(["fixture"], "run.logstudio.zip");
    const progress = vi.fn();
    const result = importSessionFile(file, " Named run ", progress);
    const request = RequestStub.instances.at(-1);
    expect(request).toBeDefined();
    expect(request?.open).toHaveBeenCalledWith("POST", "api/import?format=bundle&name=Named+run");
    expect(request?.setRequestHeader).toHaveBeenCalledWith(ClearActionHeader, ImportActionValue);
    expect(request?.send).toHaveBeenCalledWith(file);
    request?.upload.onprogress?.(new ProgressEvent("progress", { lengthComputable: true, loaded: 5, total: 10 }));
    expect(progress).toHaveBeenCalledWith(50);
    if (request) { request.status = 200; request.response = Session; request.onload?.(); }
    await expect(result).resolves.toEqual(Session);
  });

  it("returns explicit upload and malformed-response errors", async () => {
    vi.stubGlobal("XMLHttpRequest", RequestStub);
    const result = importSessionFile(new File(["fixture"], "run.jsonl"), "", vi.fn());
    const failed = expect(result).rejects.toThrow("Invalid records");
    const request = RequestStub.instances.at(-1);
    if (request) { request.status = 400; request.response = { error: "Invalid records" }; request.onload?.(); }
    await failed;
    const malformed = importSessionFile(new File(["fixture"], "run.jsonl"), "", vi.fn());
    const rejected = expect(malformed).rejects.toThrow("entry count");
    const invalid = RequestStub.instances.at(-1);
    if (invalid) { invalid.status = 200; invalid.response = { ...Session, entryCount: -1 }; invalid.onload?.(); }
    await rejected;
    const interrupted = importSessionFile(new File(["fixture"], "run.jsonl"), "", vi.fn());
    const disconnected = expect(interrupted).rejects.toThrow("Check the Sessions list");
    RequestStub.instances.at(-1)?.onerror?.();
    await disconnected;
  });

  it("rejects bad files before starting a request and validates session metadata", async () => {
    vi.stubGlobal("XMLHttpRequest", vi.fn());
    await expect(importSessionFile(new File([], "empty.jsonl"), "", vi.fn())).rejects.toThrow("empty");
    expect(XMLHttpRequest).not.toHaveBeenCalled();
    expect(() => readSessionInfo({ ...Session, arguments: [1] })).toThrow("arguments");
  });

  it("targets the chosen saved session for mutations and requires deletion confirmation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(Session)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: false })));
    vi.stubGlobal("fetch", fetcher);
    await expect(renameSession("saved/id", "New name")).resolves.toEqual(Session);
    expect(fetcher).toHaveBeenNthCalledWith(1, "api/sessions?sessionId=saved%2Fid",
      expect.objectContaining({ body: JSON.stringify({ name: "New name" }) }));
    await deleteSession("saved/id");
    await expect(deleteSession("saved/id")).rejects.toThrow("did not confirm");
  });

  it("saves only persistent filters with a protected, keepalive session action", async () => {
    const filters = sessionFilters({ ...defaultQuery(), search: "needle", levels: [], category: "null", dismissedThrough: 99, sessionId: "other" });
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await saveSessionFilters("saved/id", filters);
    expect(fetcher).toHaveBeenCalledWith("api/sessions?sessionId=saved%2Fid", {
      method: "POST", keepalive: true,
      headers: { [ClearActionHeader]: SaveFiltersActionValue, "Content-Type": "application/json" },
      body: JSON.stringify({ filters })
    });
    expect(filters).not.toHaveProperty("dismissedThrough");
    expect(filters).not.toHaveProperty("sessionId");
    expect(filters).not.toHaveProperty("pageSize");
  });

  it("reads optional saved filters without losing empty levels or null-category selections", () => {
    const filters = sessionFilters({
      ...defaultQuery(), search: "Failure", matchCase: true, levels: [], category: "null", timeWindow: 60000,
      conditions: [{ mode: "exclude", field: "message", operator: "contains", value: "heartbeat" }], includeMode: "any"
    });
    expect(readSessionInfo({ ...Session, filters }).filters).toEqual(filters);
    const padded = { ...filters, category: " ".repeat(4096) + '"Example"' };
    expect(readSessionInfo({ ...Session, filters: padded }).filters).toEqual(padded);
    expect(readSessionInfo({ ...Session, filters: null })).toEqual(Session);
    expect(readSessionInfo(Session)).toEqual(Session);
  });

  it.each([
    { levels: ["unsupported"] }, { levels: {} }, { conditions: null },
    { conditions: [{ mode: "include", field: "message", operator: "script", value: "x" }] },
    { conditions: [{ mode: "include", field: "message", operator: "contains", value: "" }] },
    { includeMode: "other" }, { timeWindow: -1 }, { timeWindow: 1 }, { matchCase: "true" },
    { since: "invalid" }, { until: null }, { since: "2026-10-12T00:00:00Z", until: "2026-10-11T00:00:00Z" },
    { timeWindow: 60000, until: "2026-10-11T00:00:00Z" },
    { category: "{}" }, { category: "not JSON" }, { category: JSON.stringify("x".repeat(513)) },
    { severity: "1" }, { stream: "other" }
  ])("rejects invalid saved filters %j", invalid => {
    expect(() => readSessionInfo({ ...Session, filters: { ...sessionFilters(defaultQuery()), ...invalid } })).toThrow();
  });

  it("reports errors when filters cannot be saved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Invalid filters" }), { status: 400 })));
    await expect(saveSessionFilters("", sessionFilters(defaultQuery()))).rejects.toThrow("Invalid filters");
  });
});
