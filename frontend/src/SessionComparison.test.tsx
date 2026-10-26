import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./comparison-api";
import { comparisonGroup, comparisonSessions, comparisonSnapshot } from "./comparison-test-fixtures";
import { defaultQuery, sessionFilters } from "./model";
import { SessionComparison } from "./SessionComparison";

vi.mock("./comparison-api", () => ({
  startComparison: vi.fn(), fetchComparison: vi.fn(), cancelComparison: vi.fn(), fetchComparisonGroups: vi.fn(), fetchComparisonEvidence: vi.fn()
}));
function choose(label: string, option: string | RegExp) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("option", { name: option }), { key: "Enter" });
}
function mount() { return render(<SessionComparison sessions={comparisonSessions} onClose={vi.fn()} returnFocus={vi.fn()} />); }
function selectRuns() {
  choose("Baseline session", /Before run/);
  choose("Candidate session", /After run/);
}
async function start() {
  selectRuns();
  fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
  await screen.findByRole("button", { name: "View baseline evidence for Request <number> failed" });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.startComparison).mockResolvedValue(comparisonSnapshot());
  vi.mocked(api.fetchComparison).mockResolvedValue(comparisonSnapshot());
  vi.mocked(api.cancelComparison).mockResolvedValue(comparisonSnapshot({ state: "cancelled" }));
  vi.mocked(api.fetchComparisonGroups).mockResolvedValue({ groups: [comparisonGroup()], total: 1, offset: 0, pageSize: 50 });
  vi.mocked(api.fetchComparisonEvidence).mockImplementation(async (_id, _group, side, sessionId, after) => ({
    sessionId, entries: [{ id: after + 1, timestamp: "2026-10-11T08:00:30Z", severity: "error", category: "Worker", stream: "stderr",
      message: `${side} original record ${after + 1}`, isPartial: false }], nextAfter: after === 0 ? 1 : null
  }));
});
describe("saved run comparison", () => {
  it("requires explicit distinct baseline/candidate roles and excludes current and unfinished sessions", () => {
    mount();
    expect(screen.getByRole("button", { name: "Compare runs" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Baseline session" }), { key: "Enter" });
    expect(screen.queryByRole("option", { name: /Current excluded/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Unfinished excluded/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("option", { name: /Before run/ }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Compare runs" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Candidate session" }), { key: "Enter" });
    expect(screen.queryByRole("option", { name: /Before run/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("option", { name: /After run/ }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Compare runs" }).hasAttribute("disabled")).toBe(false);
    expect(api.startComparison).not.toHaveBeenCalled();
  });
  it("renders stored versus actual counts, exact deltas, side timestamps, durations and normalization cautions", async () => {
    mount();
    await start();
    expect(api.startComparison).toHaveBeenCalledWith({ baselineId: "baseline", candidateId: "candidate", grouping: "normalized", filterScope: "all" });
    const baseline = within(screen.getByRole("region", { name: "Baseline run details" }));
    expect(baseline.getByText("900")).toBeDefined();
    expect(baseline.getAllByText("100")).toHaveLength(2);
    expect(baseline.getByText("60000 ms")).toBeDefined();
    expect(baseline.getByText("2026-10-11T08:01:00Z")).toBeDefined();
    expect(screen.getByRole("cell", { name: "+3" })).toBeDefined();
    expect(screen.getByText(/Replace GUIDs/)).toBeDefined();
    expect(screen.getByText(/not root causes/).textContent).toContain("collisions");
    expect(screen.getByText(/not root causes/).textContent).toContain("not rate-normalized");
    expect(screen.getByText(/records evicted from the retained window/).textContent).toContain("Stored counts are session metadata");
    expect(screen.getByText(/220 \/ 220 entries processed/)).toBeDefined();
    for (const label of ["Newly observed", "Resolved", "Count changed", "Unchanged", "All changes"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(api.fetchComparisonGroups).toHaveBeenLastCalledWith("comparison/one", "message",
        label === "All changes" ? "all" : label === "Count changed" ? "changed" : label === "Newly observed" ? "new" : label.toLowerCase(), 0, expect.any(AbortSignal)));
    }
    fireEvent.click(screen.getByRole("button", { name: "Severity summary" }));
    await waitFor(() => expect(api.fetchComparisonGroups).toHaveBeenLastCalledWith("comparison/one", "severity", "all", 0, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Category summary" }));
    await waitFor(() => expect(api.fetchComparisonGroups).toHaveBeenLastCalledWith("comparison/one", "category", "all", 0, expect.any(AbortSignal)));
  });
  it("uses each session's frozen saved filters, resolved time bounds/conditions, and raw grouping", async () => {
    const snapshot = comparisonSnapshot({ grouping: "raw", normalizationRule: "Exact raw messages; no normalization." });
    snapshot.baseline.filters = sessionFilters({ ...defaultQuery(), search: "Failure", matchCase: true,
      since: "2026-10-11T08:00:30Z", until: "2026-10-11T08:01:00Z",
      conditions: [{ mode: "exclude", field: "message", operator: "contains", value: "heartbeat" }] });
    snapshot.candidate.filters = sessionFilters({ ...defaultQuery(), since: "2026-10-12T08:01:30Z", until: "2026-10-12T08:02:00Z", levels: [], category: "null" });
    vi.mocked(api.startComparison).mockResolvedValue(snapshot);
    mount();
    selectRuns();
    choose("Comparison filter scope", "Each session’s saved filters");
    choose("Message grouping", "Raw messages (exact)");
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    await screen.findByText(/Exact raw messages/);
    expect(api.startComparison).toHaveBeenCalledWith({ baselineId: "baseline", candidateId: "candidate", grouping: "raw", filterScope: "saved" });
    expect(screen.getByText("2026-10-11T08:00:30Z")).toBeDefined();
    expect(screen.getByText("2026-10-12T08:01:30Z")).toBeDefined();
    expect(screen.getByText('exclude · message · contains · "heartbeat"')).toBeDefined();
    expect(screen.getByText("None (no levels selected)")).toBeDefined();
    expect(screen.getAllByText("Saved filters (frozen for this comparison)")).toHaveLength(2);
  });
  it("shows exact positive, negative and zero candidate-minus-baseline deltas without cross-session ID matching", async () => {
    vi.mocked(api.fetchComparisonGroups).mockResolvedValue({ groups: [
      comparisonGroup({ id: "new", label: "New event", baselineCount: 0, candidateCount: 11, delta: 11, change: "new" }),
      comparisonGroup({ id: "resolved", label: "Resolved event", baselineCount: 13, candidateCount: 0, delta: -13, change: "resolved" }),
      comparisonGroup({ id: "unchanged", label: "Unchanged event", baselineCount: 17, candidateCount: 17, delta: 0, change: "unchanged" })
    ], total: 3, offset: 0, pageSize: 50 });
    mount();
    selectRuns();
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    await screen.findByRole("cell", { name: "-13" });
    const added = within(screen.getByRole("row", { name: /New event/ }));
    expect(added.getByRole("cell", { name: "+11" })).toBeDefined();
    expect(added.getByRole("button", { name: "View baseline evidence for New event" }).hasAttribute("disabled")).toBe(true);
    const resolved = within(screen.getByRole("row", { name: /Resolved event/ }));
    expect(resolved.getByRole("cell", { name: "-13" })).toBeDefined();
    expect(resolved.getByRole("button", { name: "View candidate evidence for Resolved event" }).hasAttribute("disabled")).toBe(true);
    expect(within(screen.getByRole("row", { name: /Unchanged event/ })).getByRole("cell", { name: "0" })).toBeDefined();
  });
  it("labels saved scope independently when only one side has saved filters", async () => {
    const snapshot = comparisonSnapshot();
    snapshot.baseline.filters = sessionFilters({ ...defaultQuery(), search: "Failure" });
    vi.mocked(api.startComparison).mockResolvedValue(snapshot);
    mount();
    selectRuns();
    choose("Comparison filter scope", "Each session’s saved filters");
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    await screen.findByText("No saved filters — all history");
    expect(within(screen.getByRole("region", { name: "Baseline run details" })).getByText("Saved filters (frozen for this comparison)")).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Candidate run details" })).getByText("No saved filters — all history")).toBeDefined();
  });
  it("pages groups/evidence on both sides with session-local identical IDs and returns to the same result filter/page", async () => {
    vi.mocked(api.fetchComparisonGroups).mockImplementation(async (_id, _kind, _change, offset) =>
      ({ groups: [comparisonGroup({ id: `group/${offset}` })], total: 51, offset, pageSize: 50 }));
    mount();
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Count changed" }));
    await waitFor(() => expect(api.fetchComparisonGroups).toHaveBeenLastCalledWith("comparison/one", "message", "changed", 0, expect.any(AbortSignal)));
    await screen.findByRole("button", { name: "Next groups" });
    fireEvent.click(screen.getByRole("button", { name: "Next groups" }));
    await screen.findByText("51–51 of 51 groups · up to 50 per page");
    const returnButton = screen.getByRole("button", { name: "View baseline evidence for Request <number> failed" });
    fireEvent.click(returnButton);
    await screen.findByText("baseline original record 1");
    expect(api.fetchComparisonEvidence).toHaveBeenLastCalledWith("comparison/one", "group/50", "baseline", "baseline", 0, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Next evidence" }));
    await screen.findByText("baseline original record 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous evidence" }));
    await screen.findByText("baseline original record 1");
    fireEvent.click(screen.getByRole("button", { name: "Read candidate evidence" }));
    await screen.findByText("candidate original record 1");
    expect(api.fetchComparisonEvidence).toHaveBeenLastCalledWith("comparison/one", "group/50", "candidate", "candidate", 0, expect.any(AbortSignal));
    const requests = vi.mocked(api.fetchComparisonGroups).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Back to comparison results" }));
    expect(screen.getByText("51–51 of 51 groups · up to 50 per page")).toBeDefined();
    expect(screen.getByRole("button", { name: "Count changed" }).getAttribute("aria-pressed")).toBe("true");
    expect(api.fetchComparisonGroups).toHaveBeenCalledTimes(requests);
    await waitFor(() => expect(document.activeElement).toBe(returnButton));
  });
  it("cancels pending creation and releases its eventual job without displaying stale results", async () => {
    const pending = deferred<api.ComparisonSnapshot>();
    vi.mocked(api.startComparison).mockReturnValue(pending.promise);
    mount();
    selectRuns();
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel comparison" }));
    expect(screen.getByText(/Comparison cancelled/)).toBeDefined();
    await act(async () => { pending.resolve(comparisonSnapshot()); });
    expect(api.cancelComparison).toHaveBeenCalledWith("comparison/one");
    expect(screen.queryByRole("region", { name: "Comparison results" })).toBeNull();
  });
  it("aborts stale evidence across controls and ignores its eventual response", async () => {
    mount();
    await start();
    const pending = deferred<api.ComparisonEvidence>();
    vi.mocked(api.fetchComparisonEvidence).mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "View baseline evidence for Request <number> failed" }));
    const evidenceSignal = vi.mocked(api.fetchComparisonEvidence).mock.lastCall![5];
    choose("Message grouping", "Raw messages (exact)");
    expect(evidenceSignal.aborted).toBe(true);
    await act(async () => { pending.resolve({ sessionId: "baseline", entries: [{ id: 1, timestamp: "2026-10-11T08:00:00Z", severity: "error", category: null, stream: "stdout", message: "STALE RECORD", isPartial: false }], nextAfter: null }); });
    expect(screen.queryByText("STALE RECORD")).toBeNull();
    expect(screen.queryByRole("region", { name: "Comparison results" })).toBeNull();
    expect(api.cancelComparison).toHaveBeenCalledWith("comparison/one");
  });
  it("aborts obsolete result pages and ignores responses from the previous change filter", async () => {
    mount();
    await start();
    const pending = deferred<api.ComparisonGroups>();
    vi.mocked(api.fetchComparisonGroups).mockReturnValueOnce(pending.promise).mockResolvedValue({
      groups: [comparisonGroup({ id: "resolved", label: "Current result", baselineCount: 3, candidateCount: 0, delta: -3, change: "resolved" })],
      total: 1, offset: 0, pageSize: 50
    });
    fireEvent.click(screen.getByRole("button", { name: "Newly observed" }));
    const oldSignal = vi.mocked(api.fetchComparisonGroups).mock.lastCall![4];
    fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
    await screen.findByRole("rowheader", { name: /Current result/ });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { pending.resolve({ groups: [comparisonGroup({ label: "STALE GROUP" })], total: 1, offset: 0, pageSize: 50 }); });
    expect(screen.queryByText("STALE GROUP")).toBeNull();
    expect(screen.getByRole("rowheader", { name: /Current result/ })).toBeDefined();
  });
  it("aborts evidence on unmount and releases the completed comparison job", async () => {
    const { unmount } = mount();
    await start();
    const pending = deferred<api.ComparisonEvidence>();
    vi.mocked(api.fetchComparisonEvidence).mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "View baseline evidence for Request <number> failed" }));
    const evidenceSignal = vi.mocked(api.fetchComparisonEvidence).mock.lastCall![5];
    unmount();
    expect(evidenceSignal.aborted).toBe(true);
    expect(api.cancelComparison).toHaveBeenCalledWith("comparison/one");
    await act(async () => { pending.resolve({ sessionId: "baseline", entries: [], nextAfter: null }); });
  });
  it("polls completed jobs for deletion invalidation and removes visible evidence", async () => {
    mount();
    await start();
    fireEvent.click(screen.getByRole("button", { name: "View baseline evidence for Request <number> failed" }));
    await screen.findByText("baseline original record 1");
    vi.mocked(api.fetchComparison).mockResolvedValue(comparisonSnapshot({ state: "invalidated", error: "Source history was deleted." }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("invalidated"), { timeout: 3500 });
    expect(screen.queryByText("baseline original record 1")).toBeNull();
    expect(screen.queryByRole("region", { name: "Comparison results" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Comparison evidence" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Baseline run details" })).toBeNull();
  });
  it("shows running progress, cancellation and failed states explicitly, releasing jobs on unmount", async () => {
    vi.mocked(api.startComparison).mockResolvedValue(comparisonSnapshot({ state: "running", phase: "baseline", processedEntries: 50 }));
    const { unmount } = mount();
    selectRuns();
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    await screen.findByText(/50 \/ 220 entries processed/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel comparison" }));
    await screen.findByText(/Comparison cancelled/);
    expect(api.cancelComparison).toHaveBeenCalledWith("comparison/one");
    vi.mocked(api.startComparison).mockResolvedValue(comparisonSnapshot({ state: "failed", error: "Unreadable source journal." }));
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Unreadable source journal");
    unmount();
    expect(api.cancelComparison).toHaveBeenCalledTimes(2);
  });
});
