import { describe, expect, it, vi } from "vitest";
import { fetchApplications, readPage, readStatus, selectApplication } from "./api";
import { Entry, fixturePage, Status } from "./test-fixtures";

describe("typed server payloads", () => {
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
    const entries = Array.from({ length: 500 }, (_, index) => ({ ...Entry, id: index + 1 }));
    expect(readPage({ ...fixturePage(), entries, pageSize: 500 }, 500).entries).toHaveLength(500);
    expect(() => readPage({ ...fixturePage(), entries, pageSize: 250 }, 250)).toThrow("one page");
    expect(() => readPage({ ...fixturePage(), pageSize: 1001 }, 1001)).toThrow("page size");
    expect(() => readPage({ ...fixturePage(), pageSize: 500 }, 250)).toThrow("page size");
  });
  it("rejects unbounded suggestions and invalid status instead of defaulting silently", () => {
    expect(() => readPage({ ...fixturePage(), categories: Array.from({ length: 1025 }, () => "category") })).toThrow("suggestions");
    expect(() => readStatus({ ...Status, retainedCount: -1 })).toThrow("retained count");
    expect(() => readStatus({ ...Status, historyDirectory: null })).toThrow("history directory");
  });
});
