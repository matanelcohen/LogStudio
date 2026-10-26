import { describe, expect, it, vi } from "vitest";
import { cancelComparison, fetchComparison, fetchComparisonEvidence, fetchComparisonGroups, readComparison, startComparison } from "./comparison-api";
import { comparisonGroup, comparisonSnapshot } from "./comparison-test-fixtures";
import { defaultQuery, sessionFilters } from "./model";

const signal = new AbortController().signal;
function respond(data: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("comparison API", () => {
  it("creates a protected comparison without mutating session selection and fetches/cancels by qualified ID", async () => {
    const options = { baselineId: "baseline", candidateId: "candidate", grouping: "normalized" as const, filterScope: "all" as const };
    let fetcher = respond(comparisonSnapshot());
    await expect(startComparison(options)).resolves.toEqual(comparisonSnapshot());
    expect(fetcher).toHaveBeenCalledWith("api/comparison", {
      method: "POST", headers: { "X-Log-Studio-Action": "compare", "Content-Type": "application/json" }, body: JSON.stringify(options)
    });
    fetcher = respond(comparisonSnapshot());
    await fetchComparison("comparison/one", signal);
    expect(fetcher).toHaveBeenCalledWith("api/comparison?id=comparison%2Fone", { signal });
    fetcher = respond(comparisonSnapshot({ state: "cancelled" }));
    await cancelComparison("comparison/one");
    expect(fetcher).toHaveBeenCalledWith("api/comparison?id=comparison%2Fone",
      { method: "POST", keepalive: true, headers: { "X-Log-Studio-Action": "cancel-comparison" } });
  });
  it("reads frozen saved filters, resolved bounds and raw grouping", async () => {
    const filters = sessionFilters({ ...defaultQuery(), since: "2026-10-11T08:00:30Z", until: "2026-10-11T08:01:00Z" });
    const snapshot = comparisonSnapshot({ grouping: "raw" });
    snapshot.baseline.filters = filters;
    snapshot.candidate.filters = { ...filters, since: "2026-10-12T08:01:30Z", until: "2026-10-12T08:02:00Z" };
    respond(snapshot);
    await expect(startComparison({ baselineId: "baseline", candidateId: "candidate", grouping: "raw", filterScope: "saved" })).resolves.toEqual(snapshot);
  });
  it.each(["baseline", "candidate", "both"] as const)("accepts saved scope when %s has no saved filters", async missing => {
    const snapshot = comparisonSnapshot();
    const filters = sessionFilters({ ...defaultQuery(), search: "Failure" });
    snapshot.baseline.filters = missing === "candidate" ? filters : null;
    snapshot.candidate.filters = missing === "baseline" ? filters : null;
    respond(snapshot);
    await expect(startComparison({ baselineId: "baseline", candidateId: "candidate", grouping: "normalized", filterScope: "saved" })).resolves.toEqual(snapshot);
  });
  it.each(["baseline", "candidate"] as const)("rejects all-history scope when %s contains filters", async side => {
    const snapshot = comparisonSnapshot();
    snapshot[side].filters = sessionFilters(defaultQuery());
    respond(snapshot);
    await expect(startComparison({ baselineId: "baseline", candidateId: "candidate", grouping: "normalized", filterScope: "all" })).rejects.toThrow("different comparison");
  });
  it.each([
    { processedEntries: -1 }, { processedEntries: 221 }, { totalEntries: Number.MAX_SAFE_INTEGER + 1 },
    { state: "unknown" }, { grouping: "fuzzy" }, { normalizationRule: null }, { id: "" }, { error: false },
    { baseline: { ...comparisonSnapshot().baseline, matchedCount: 101 } },
    { baseline: { ...comparisonSnapshot().baseline, durationMilliseconds: -1 } },
    { baseline: { ...comparisonSnapshot().baseline, session: { ...comparisonSnapshot().baseline.session, isCurrent: true } } },
    { baseline: { ...comparisonSnapshot().baseline, session: { ...comparisonSnapshot().baseline.session, completedAt: null } } },
    { baseline: { ...comparisonSnapshot().baseline, filters: { ...sessionFilters(defaultQuery()), timeWindow: 60000 } } },
    { candidate: comparisonSnapshot().baseline }
  ])("rejects malformed snapshot fields and bounds %j", invalid => {
    expect(() => readComparison({ ...comparisonSnapshot(), ...invalid })).toThrow();
  });
  it("rejects incorrect identities/scopes and surfaces server errors", async () => {
    const fetcher = respond(comparisonSnapshot());
    await expect(startComparison({ baselineId: "baseline", candidateId: "baseline", grouping: "raw", filterScope: "all" })).rejects.toThrow("distinct");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fetchComparison("other", signal)).rejects.toThrow("different comparison");
    respond(comparisonSnapshot());
    await expect(startComparison({ baselineId: "baseline", candidateId: "candidate", grouping: "raw", filterScope: "saved" })).rejects.toThrow("different comparison");
    respond({ error: "Source session was deleted." }, 409);
    await expect(fetchComparison("comparison/one", signal)).rejects.toThrow("Source session was deleted.");
  });
  it("requests paged group kinds/change splits and checks exact deltas", async () => {
    const page = { groups: [comparisonGroup()], total: 51, offset: 50, pageSize: 50 };
    const fetcher = respond(page);
    await expect(fetchComparisonGroups("comparison/one", "message", "changed", 50, signal)).resolves.toEqual(page);
    expect(fetcher).toHaveBeenCalledWith("api/comparison/groups?id=comparison%2Fone&kind=message&change=changed&offset=50", { signal });
  });
  it.each([
    { pageSize: 51 }, { offset: 1 }, { total: -1 }, { total: 0 },
    { groups: Array.from({ length: 51 }, () => comparisonGroup()) },
    { groups: [comparisonGroup({ delta: 4 })] }, { groups: [comparisonGroup({ change: "new" })] },
    { groups: [comparisonGroup({ baselineCount: -1 })] }, { groups: [comparisonGroup({ kind: "severity" })] },
    { groups: [comparisonGroup(), comparisonGroup()] }
  ])("rejects malformed groups and page bounds %j", async invalid => {
    respond({ groups: [comparisonGroup()], total: 2, offset: 0, pageSize: 50, ...invalid });
    await expect(fetchComparisonGroups("comparison/one", "message", "all", 0, signal)).rejects.toThrow();
  });
  const entry = { id: 1, timestamp: "2026-10-11T08:00:30Z", severity: "error", category: "Worker", stream: "stderr", message: "Request 123 failed", isPartial: false };
  it("qualifies evidence by comparison, group and side, allowing identical IDs in different sessions", async () => {
    let fetcher = respond({ sessionId: "baseline", entries: [entry], nextAfter: 1 });
    await expect(fetchComparisonEvidence("comparison/one", "group/one", "baseline", "baseline", 0, signal)).resolves.toMatchObject({ entries: [entry], nextAfter: 1 });
    expect(fetcher).toHaveBeenCalledWith("api/comparison/evidence?id=comparison%2Fone&groupId=group%2Fone&side=baseline&after=0", { signal });
    fetcher = respond({ sessionId: "candidate", entries: [{ ...entry, message: "Request 456 failed" }], nextAfter: null });
    const result = await fetchComparisonEvidence("comparison/one", "group/one", "candidate", "candidate", 0, signal);
    expect(result.entries[0]!.id).toBe(1);
    expect(result.entries[0]!.message).toBe("Request 456 failed");
    expect(fetcher.mock.calls[0]![0]).toContain("side=candidate");
  });
  it("accepts an exhausted final evidence page containing exactly 50 original records", async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({ ...entry, id: index + 1 }));
    respond({ sessionId: "baseline", entries, nextAfter: null });
    await expect(fetchComparisonEvidence("comparison/one", "group/one", "baseline", "baseline", 0, signal))
      .resolves.toEqual({ sessionId: "baseline", entries, nextAfter: null });
  });
  it.each([
    { sessionId: "candidate" }, { entries: Array.from({ length: 51 }, () => entry) }, { entries: [{ ...entry, id: 0 }] },
    { entries: [entry, entry] }, { entries: [{ ...entry, severity: "unknown" }] },
    { entries: [{ ...entry, timestamp: "invalid" }] }, { nextAfter: 0 }, { nextAfter: 2 }, { entries: [], nextAfter: 1 }
  ])("rejects malformed, unqualified and unbounded evidence %j", async invalid => {
    respond({ sessionId: "baseline", entries: [entry], nextAfter: null, ...invalid });
    await expect(fetchComparisonEvidence("comparison/one", "group/one", "baseline", "baseline", 0, signal)).rejects.toThrow();
  });
});
