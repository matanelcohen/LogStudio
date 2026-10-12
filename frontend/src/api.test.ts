import { describe, expect, it } from "vitest";
import { readPage, readStatus } from "./api";
import { Entry, fixturePage, Status } from "./test-fixtures";

describe("typed server payloads", () => {
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
