import { describe, expect, it, vi } from "vitest";
import { deleteSession, importSessionFile, readSessionInfo, renameSession } from "./api";
import { ClearActionHeader, ImportActionValue, type SessionInfo } from "./model";

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
});
