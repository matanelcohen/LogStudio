import { describe, expect, it } from "vitest";
import { buildExportUrl, buildQueryParameters, buildSessionExportUrl, defaultQuery, importFormat, MaximumImportBytes, validateConditions, validateImportFile, type LogCondition } from "./model";

describe("disk query contracts", () => {
  it("keeps search, conditions, snapshot bounds, and all/any semantics in exports", () => {
    const conditions: LogCondition[] = [
      { mode: "include", field: "message", operator: "regex", value: "^skill [0-9]+$" },
      { mode: "exclude", field: "category", operator: "startsWith", value: "Microsoft." }
    ];
    const query = { ...defaultQuery(), search: '"exact phrase" -heartbeat', conditions, includeMode: "any" as const, dismissedThrough: 10 };
    const parameters = buildQueryParameters(query, { before: 250, after: null }, 20000);
    expect(parameters.get("q")).toBe(query.search);
    expect(JSON.parse(parameters.get("filters") ?? "")).toEqual(conditions);
    expect(parameters.get("includeMode")).toBe("any");
    expect(parameters.get("before")).toBe("250");
    expect(parameters.get("pageSize")).toBe("250");
    expect(parameters.get("minId")).toBe("10");
    const exported = new URL(buildExportUrl(query, 20000), "http://localhost/");
    expect(exported.pathname).toBe("/api/export");
    expect(exported.searchParams.get("maxId")).toBe("20000");
    expect(exported.searchParams.has("before")).toBe(false);
    expect(exported.searchParams.has("after")).toBe(false);
    expect(JSON.parse(exported.searchParams.get("filters") ?? "")).toEqual(conditions);
  });

  it("computes relative windows at request time and preserves null category", () => {
    const query = { ...defaultQuery(), timeWindow: 60000, category: "null", matchCase: true, stream: "stderr", severity: "errorPlus" };
    const parameters = buildQueryParameters(query, { before: null, after: 250 }, null, Date.parse("2026-10-11T18:00:00Z"));
    expect(parameters.get("since")).toBe("2026-10-11T17:59:00.000Z");
    expect(parameters.get("category")).toBe("null");
    expect(parameters.get("matchCase")).toBe("true");
    expect(parameters.get("stream")).toBe("stderr");
    expect(parameters.get("severity")).toBe("errorPlus");
    expect(parameters.get("after")).toBe("250");
  });

  it("serializes arbitrary level combinations consistently for search and export", () => {
    const query = { ...defaultQuery(), levels: ["information", "error"] as ("information" | "error")[] };
    const parameters = buildQueryParameters(query, { before: null, after: null }, null);
    expect(JSON.parse(parameters.get("levels") ?? "")).toEqual(["information", "error"]);
    expect(parameters.has("severity")).toBe(false);
    const exported = new URL(buildExportUrl(query, 20000), "http://localhost/");
    expect(JSON.parse(exported.searchParams.get("levels") ?? "")).toEqual(query.levels);
    expect(buildQueryParameters({ ...query, levels: [] }, { before: null, after: null }, null).get("levels")).toBe("[]");
  });
  it("validates condition limits without treating regex as JavaScript regex", () => {
    const condition: LogCondition = { mode: "include", field: "message", operator: "regex", value: "[" };
    expect(validateConditions([condition])).toBeNull();
    expect(validateConditions([{ ...condition, value: "" }])).toContain("value");
    expect(validateConditions(Array.from({ length: 17 }, () => condition))).toContain("16");
    expect(validateConditions([{ ...condition, value: "x".repeat(257) }])).toContain("256");
    expect(validateConditions(Array.from({ length: 16 }, () => ({ ...condition, value: "x".repeat(256) })))).toContain("4096");
  });
  it("exports full retained sessions without inheriting search or page filters", () => {
    const url = new URL(buildSessionExportUrl("saved/id"), "http://localhost/");
    expect(url.pathname).toBe("/api/export-session");
    expect([...url.searchParams]).toEqual([["sessionId", "saved/id"]]);
    expect(buildSessionExportUrl()).toBe("api/export-session");
  });
  it("detects supported imports and validates exact upload bounds", () => {
    expect(importFormat("backup.LOGSTUDIO.ZIP")).toBe("bundle");
    expect(importFormat("errors.NDJSON")).toBe("jsonl");
    expect(importFormat("output.jsonl")).toBe("jsonl");
    expect(importFormat("output.txt")).toBeNull();
    expect(validateImportFile({ name: "run.zip", size: MaximumImportBytes })).toBeNull();
    expect(validateImportFile({ name: "run.zip", size: MaximumImportBytes + 1 })).toContain("256 MiB");
    expect(validateImportFile({ name: "run.jsonl", size: 0 })).toContain("empty");
    expect(validateImportFile({ name: "run.csv", size: 10 })).toContain("Choose");
  });
});
