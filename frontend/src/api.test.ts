import { describe, expect, it, vi } from "vitest";
import { fetchApplications, fetchContext, readPage, readStatus, selectApplication, sendInput } from "./api";
import { Entry, fixturePage, Status } from "./test-fixtures";

describe("typed server payloads", () => {
  const location = { sessionId: "11111111111111111111111111111111", entryId: 1 };
  const context = { sessionId: location.sessionId, anchorId: 1, entries: [Entry], status: Status, before: null, after: 1, filtersBypassed: true };

  it("pins context to an explicit session and anchor without forwarding search filters", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(context)));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await fetchContext(location, { before: null, after: null }, signal)).toEqual({ ...context, status: readStatus(Status) });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`api/context?sessionId=${location.sessionId}&entryId=1`, { signal });
  });

  it.each([
    { sessionId: "22222222222222222222222222222222" }, { anchorId: 2 }, { filtersBypassed: false },
    { entries: Array.from({ length: 52 }, () => Entry) }, { entries: [] },
    { status: { ...Status, clearedThroughId: 1 } }, { before: 2 },
    { entries: [Entry, Entry] }
  ])("rejects invalid, cross-session or stale context: %j", async changes => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...context, ...changes }))));
    await expect(fetchContext(location, { before: null, after: null }, new AbortController().signal)).rejects.toThrow(/context/);
  });

  it("bounds continuation pages and propagates explicit anchor failures", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...context, entries: Array.from({ length: 26 }, (_, index) => ({ ...Entry, id: index + 2 })) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "The anchor expired." }), { status: 410 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchContext(location, { before: null, after: 1 }, new AbortController().signal)).rejects.toThrow("invalid surrounding context");
    await expect(fetchContext(location, { before: null, after: null }, new AbortController().signal)).rejects.toThrow("anchor expired");
    expect(fetch.mock.calls[0]![0]).toContain("&after=1");
  });

  it("reads input availability while remaining compatible with saved statuses", () => {
    expect(readStatus(Status).canWriteInput).toBe(false);
    expect(readStatus({ ...Status, canWriteInput: true }).canWriteInput).toBe(true);
    expect(() => readStatus({ ...Status, canWriteInput: "true" })).toThrow("terminal input availability");
  });

  it.each(["  hello 世界 👋  ", "", "\t", "x".repeat(4096)])("sends protected terminal input unchanged: %j", async input => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sent: true })));
    vi.stubGlobal("fetch", fetch);
    await sendInput(input);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("api/input", {
      method: "POST", headers: { "X-Log-Studio-Action": "input", "Content-Type": "application/json" },
      body: JSON.stringify({ text: input })
    });
  });

  it.each(["x".repeat(4097), "first\nsecond", "\r", "\0", "\x1b", "\x7f", "\x85"])("rejects oversized or control input before sending", async input => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(sendInput(input)).rejects.toThrow("single line");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces input failures and requires an explicit success acknowledgement", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Input closed." }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sent: false })));
    vi.stubGlobal("fetch", fetch);
    await expect(sendInput("answer")).rejects.toThrow("Input closed.");
    await expect(sendInput("answer")).rejects.toThrow("did not confirm");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads selection mode while remaining compatible with saved statuses", () => {
    expect(readStatus(Status).listenAll).toBe(false);
    expect(readStatus({ ...Status, listenAll: true }).listenAll).toBe(true);
    expect(() => readStatus({ ...Status, listenAll: "true" })).toThrow("application selection mode");
  });

  it("lists apps without attaching and preserves exact process identity on explicit selection", async () => {
    const application = { processId: 42, name: "Example.Api", startedAtTicks: "639112345678901234" };
    const state = { applications: [application], selected: null, error: null };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...state, selected: application })));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await fetchApplications(signal)).toEqual(state);
    expect(fetch).toHaveBeenNthCalledWith(1, "api/applications", { signal });
    expect((await selectApplication(application)).selected).toEqual(application);
    expect(fetch).toHaveBeenNthCalledWith(2, "api/applications?processId=42&startedAtTicks=639112345678901234", {
      method: "POST", headers: { "X-Log-Studio-Action": "select-application" }
    });
  });

  it("rejects numeric start identities that lose precision and surfaces selection failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      applications: [{ processId: 42, name: "App", startedAtTicks: 639112345678901234 }], selected: null, error: null
    }))).mockResolvedValueOnce(new Response(JSON.stringify({ error: "Application exited." }), { status: 409 })));
    await expect(fetchApplications(new AbortController().signal)).rejects.toThrow("process start identity");
    await expect(selectApplication({ processId: 42, name: "App", startedAtTicks: "639112345678901234" })).rejects.toThrow("Application exited.");
  });

  it("reads grouped app paths and member identities and explicitly requests application capture", async () => {
    const process = { processId: 42, name: "Api", startedAtTicks: "639112345678901234", path: "/apps/Api.dll" };
    const application = { ...process, groupId: "path:/apps/Api.dll", processes: [process, { ...process, processId: 43 }], isTool: false };
    const state = { applications: [application], selected: application, error: null };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(state)));
    vi.stubGlobal("fetch", fetch);
    expect((await selectApplication(application)).selected).toEqual(application);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("api/applications?processId=42&startedAtTicks=639112345678901234&scope=application", {
      method: "POST", headers: { "X-Log-Studio-Action": "select-application" }
    });
  });

  it.each([
    [{ path: 123 }, "application path"],
    [{ groupId: false }, "application group"],
    [{ processes: {} }, "application process list"],
    [{ processes: [{ processId: 43, name: "Worker", startedAtTicks: 639112345678901235 }] }, "process start identity"],
    [{ isTool: "false" }, "application tooling flag"]
  ])("rejects malformed group metadata: %j", async (metadata, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      applications: [{ processId: 42, name: "Api", startedAtTicks: "639112345678901234", ...metadata }], selected: null, error: null
    }))));
    await expect(fetchApplications(new AbortController().signal)).rejects.toThrow(message);
  });

  it("accepts a bounded page without loading full history", () => {
    const page = readPage(fixturePage());
    expect(page.entries).toEqual([Entry]);
    expect(page.status.retainedCount).toBe(20000);
  });

  it("rejects oversized page caches and malformed entries", () => {
    expect(() => readPage({ ...fixturePage(), entries: Array.from({ length: 251 }, () => Entry) })).toThrow("one page");
    expect(() => readPage({ ...fixturePage(), entries: [{ ...Entry, severity: "unknown" }] })).toThrow("level or stream");
    expect(() => readPage({ ...fixturePage(), entries: [{ ...Entry, timestamp: "broken" }] })).toThrow("capture time");
    expect(() => readPage({ ...fixturePage(), entries: [{ ...Entry, id: Number.MAX_SAFE_INTEGER + 1 }] })).toThrow("entry ID");
  });

  it("accepts user-selected page bounds and rejects mismatched responses", () => {
    const entries = Array.from({ length: 5000 }, (_, index) => ({ ...Entry, id: index + 1 }));
    expect(readPage({ ...fixturePage(), entries, pageSize: 5000 }, 5000).entries).toHaveLength(5000);
    expect(readPage({ ...fixturePage(), entries, pageSize: 2147483647 }, 2147483647).entries).toHaveLength(5000);
    expect(() => readPage({ ...fixturePage(), entries, pageSize: 250 }, 250)).toThrow("one page");
    expect(readPage({ ...fixturePage(), pageSize: 1001 }, 1001).pageSize).toBe(1001);
    expect(() => readPage({ ...fixturePage(), pageSize: 2147483648 }, 2147483648)).toThrow("page size");
    expect(() => readPage({ ...fixturePage(), pageSize: 500 }, 250)).toThrow("page size");
  });
  it("rejects unbounded suggestions and invalid status instead of defaulting silently", () => {
    expect(() => readPage({ ...fixturePage(), categories: Array.from({ length: 1025 }, () => "category") })).toThrow("suggestions");
    expect(() => readStatus({ ...Status, retainedCount: -1 })).toThrow("retained count");
    expect(() => readStatus({ ...Status, historyDirectory: null })).toThrow("history directory");
  });
});
