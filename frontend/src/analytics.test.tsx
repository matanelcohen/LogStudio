import * as Oui from "@opensearch-project/oui";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import * as analyticsApi from "./analytics-api";
import { AnalyticsWorkspace, type AnalyticsView } from "./AnalyticsWorkspace";
import { DefaultGraph, graphPoints, readGraph, readSavedGraphs, trendSummary, type GraphDefinition, type SavedGraph } from "./analytics-model";
import { defaultQuery, sessionFilters } from "./model";
import { fixtureAnalytics } from "./test-fixtures";
import { useAnalytics } from "./useAnalytics";
import { readPreferences, DefaultPreferences } from "./preferences";

beforeEach(() => vi.spyOn(analyticsApi, "fetchAnalytics").mockResolvedValue(fixtureAnalytics()));
const suggestion: GraphDefinition = { name: "Errors by category", groupBy: "category", measure: "errors", chartType: "bar" };
function Harness({ initialView = "trends" }: { initialView?: AnalyticsView }) {
  const [view, setView] = useState<AnalyticsView | "discover">(initialView);
  const [query, setQuery] = useState(defaultQuery);
  const [graphs, setGraphs] = useState<SavedGraph[]>([]);
  if (view === "discover") return <p>Discover category: {query.category}</p>;
  return <Oui.TooltipProvider><AnalyticsWorkspace view={view} onView={setView} query={query} onQuery={setQuery}
    maximumId={null} paused={false} historyDirectory="" clearedThroughId={0} savedGraphs={graphs} onSaveGraphs={setGraphs} saved graphsReady /></Oui.TooltipProvider>;
}
async function choose(label: string, option: string) {
  fireEvent.keyDown(await screen.findByRole("combobox", { name: label }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("analytics data model", () => {
  it("keeps zero-count time buckets, calculates percentages per group, and preserves uncategorized identities", () => {
    const snapshot = fixtureAnalytics();
    expect(graphPoints(snapshot, DefaultGraph)).toHaveLength(32);
    expect(graphPoints(snapshot, DefaultGraph)[0]!.value).toBe(0);
    expect(graphPoints(snapshot, { ...suggestion, measure: "errorRate" })).toEqual([
      expect.objectContaining({ group: "App.Skill", value: 10 }), expect.objectContaining({ group: null, label: "Uncategorized", value: 10 })
    ]);
    snapshot.otherCategories = { value: null, count: 5, errorCount: 3, warningCount: 0 };
    expect(graphPoints(snapshot, suggestion).at(-1)).toEqual({ group: null, label: "Other categories (combined)", value: 3, other: true });
    expect(trendSummary(snapshot).join(" ")).toContain("10.00%");
    expect(trendSummary(snapshot).join(" ")).toContain("percentage change is undefined from zero");
    expect(trendSummary({ ...snapshot, totalCount: 0 })).toEqual([]);
  });
  it("persists graph filters, migrates old preferences, and rejects invalid or duplicate saved graphs", () => {
    const saved = { graph: suggestion, filters: sessionFilters({ ...defaultQuery(), search: "timeout" }) };
    expect(readPreferences({ ...DefaultPreferences, savedGraphs: [saved] }).savedGraphs).toEqual([saved]);
    const { savedGraphs: _, ...legacy } = DefaultPreferences;
    expect(readPreferences(legacy).savedGraphs).toEqual([]);
    expect(() => readSavedGraphs([saved, { ...saved, graph: { ...suggestion, name: "errors by category" } }])).toThrow();
    expect(() => readGraph({ ...suggestion, chartType: "line" })).toThrow();
    expect(() => readGraph({ ...suggestion, measure: "latency" })).toThrow();
    expect(() => readGraph({ ...suggestion, name: "" })).toThrow();
    expect(() => readSavedGraphs([{ ...saved, filters: { ...saved.filters, until: "invalid" } }])).toThrow();
  });
});

describe("Trends and Graphs", () => {
  it("displays full-session summaries, observations and exact tables without connecting to Copilot automatically", async () => {
    const connect = vi.spyOn(api, "connectCopilot");
    render(<Harness />);
    expect(await screen.findByLabelText("Filtered session summary")).toBeTruthy();
    expect(within(screen.getByLabelText("Filtered session summary")).getByText("1,000")).toBeTruthy();
    expect(screen.getByLabelText("Observed trends").textContent).toContain("10.00%");
    expect(screen.getAllByRole("graphics-symbol")).toHaveLength(32);
    fireEvent.focus(screen.getAllByRole("graphics-symbol").at(-1)!);
    expect(screen.getByRole("img", { name: /Log volume over time/ }).parentElement?.textContent).toContain("1,000");
    fireEvent.click(screen.getByText("View data table (32 intervals)"));
    expect(screen.getByRole("table", { name: /Log volume over time/ })).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
    expect(screen.queryByText(/private text/)).toBeNull();
  });
  it("creates, edits, reopens, and deletes saved graphs and restricts categorical charts to bars", async () => {
    render(<Harness initialView="graphs" />);
    await screen.findByLabelText("Filtered session summary");
    fireEvent.change(screen.getByLabelText("Graph name"), { target: { value: "Errors" } });
    await choose("Graph measure", "Error records");
    await choose("Graph grouping", "Category");
    expect(screen.getByRole("combobox", { name: "Graph chart type" }).textContent).toBe("Bar");
    fireEvent.click(screen.getByRole("button", { name: "Save graph" }));
    expect(await screen.findByText("Graph saved on this device.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open graph Errors" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New graph" }));
    fireEvent.click(screen.getByRole("button", { name: "Open graph Errors" }));
    expect((screen.getByLabelText("Graph name") as HTMLInputElement).value).toBe("Errors");
    fireEvent.change(screen.getByLabelText("Graph name"), { target: { value: "Updated errors" } });
    fireEvent.click(screen.getByRole("button", { name: "Update graph" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete graph Updated errors" }));
    expect(screen.queryByRole("button", { name: "Open graph Updated errors" })).toBeNull();
  });
  it("drills into an exact uncategorized group without confusing it with other categories", async () => {
    render(<Harness />);
    await screen.findByLabelText("Filtered session summary");
    fireEvent.click(screen.getByRole("button", { name: "Customize Records by category" }));
    fireEvent.click(screen.getByText("View data table (2 groups)"));
    fireEvent.click(screen.getByRole("button", { name: "Discover Uncategorized" }));
    expect(screen.getByText("Discover category: null")).toBeTruthy();
  });
  it("uses the existing Copilot connection for insights and opens its validated suggestion as an editable draft", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue({ version: "test", models: [{ id: "test-model", name: "Test model", reasoningEfforts: ["high"] }] });
    const ask = vi.spyOn(analyticsApi, "askAnalytics").mockResolvedValue({ insight: "**100 errors**, concentrated in the last interval.", graph: suggestion, contextEntryCount: 1000, throughId: 20000 });
    render(<Harness />);
    await screen.findByLabelText("Filtered session summary");
    fireEvent.click(screen.getByRole("button", { name: "Connect Copilot" }));
    await choose("Analytics AI model", "Test model");
    await choose("Analytics reasoning effort", "high");
    fireEvent.click(screen.getByRole("button", { name: "Graph errors by category" }));
    expect(await screen.findByText("100 errors")).toBeTruthy();
    expect(ask).toHaveBeenCalledWith(expect.any(URLSearchParams), "Graph errors by category", null, { model: "test-model", reasoningEffort: "high" }, expect.any(AbortSignal));
    expect(ask.mock.calls[0]![0].get("maxId")).toBe("20000");
    fireEvent.click(screen.getByRole("button", { name: "Open in Graphs" }));
    expect((screen.getByLabelText("Graph name") as HTMLInputElement).value).toBe("Errors by category");
    expect(screen.getByRole("button", { name: "Save graph" })).toBeTruthy();
    expect(screen.getByLabelText("Saved graphs").textContent).toContain("Save your first graph");
  });
  it("surfaces analytic load and Copilot failures instead of rendering invented success", async () => {
    vi.mocked(analyticsApi.fetchAnalytics).mockRejectedValueOnce(new Error("History was cleared"));
    vi.spyOn(api, "connectCopilot").mockRejectedValue(new Error("Install the Copilot CLI"));
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("History was cleared"));
    fireEvent.click(screen.getByRole("button", { name: "Retry analytics" }));
    await screen.findByLabelText("Filtered session summary");
    fireEvent.click(screen.getByRole("button", { name: "Connect Copilot" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Install the Copilot CLI"));
  });
});

describe("analytics API", () => {
  it("validates snapshot bounds and sends explicit, bounded-scope Copilot actions", async () => {
    const snapshot = fixtureAnalytics();
    expect(analyticsApi.readAnalytics(snapshot)).toEqual({ ...snapshot, status: { ...snapshot.status, canWriteInput: false, listenAll: false } });
    expect(() => analyticsApi.readAnalytics({ ...snapshot, timeline: [snapshot.timeline[0]] })).toThrow();
    expect(() => analyticsApi.readAnalytics({ ...snapshot, categories: [{ value: null, count: 1, errorCount: 2, warningCount: 0 }] })).toThrow();
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ insight: "Insight", graph: suggestion, contextEntryCount: 10, throughId: 42 }) });
    vi.stubGlobal("fetch", fetch);
    const parameters = new URLSearchParams({ sessionId: "saved", q: "timeout", maxId: "42" });
    await analyticsApi.askAnalytics(parameters, "Explain", suggestion, {}, new AbortController().signal);
    expect(fetch).toHaveBeenCalledWith("api/analytics/copilot?sessionId=saved&q=timeout&maxId=42", expect.objectContaining({
      method: "POST", headers: { "Content-Type": "application/json", "X-Log-Studio-Action": "copilot-analytics" }
    }));
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ insight: "Bad graph", graph: { ...suggestion, groupBy: "sql" }, contextEntryCount: 10, throughId: 42 }) });
    await expect(analyticsApi.askAnalytics(parameters, "Explain", null, {}, new AbortController().signal)).rejects.toThrow();
  });
});

describe("analytics refresh lifecycle", () => {
  it("uses saved-session filters and pause bounds, hides stale scopes, and aborts old requests", async () => {
    let latest: ReturnType<typeof useAnalytics> | undefined;
    function Probe({ search, maximumId = null }: { search: string; maximumId?: number | null }) {
      latest = useAnalytics({ ...defaultQuery(), sessionId: "saved", search }, maximumId, true, "", 0);
      return <span>{latest.snapshot?.totalCount ?? "Loading"}</span>;
    }
    const view = render(<Probe search="timeout" maximumId={12} />);
    await screen.findByText("1000");
    expect(analyticsApi.fetchAnalytics).toHaveBeenLastCalledWith(expect.any(URLSearchParams), expect.any(AbortSignal));
    const parameters = vi.mocked(analyticsApi.fetchAnalytics).mock.calls[0]![0];
    expect(parameters.get("sessionId")).toBe("saved");
    expect(parameters.get("q")).toBe("timeout");
    expect(parameters.get("maxId")).toBe("12");
    expect(parameters.has("pageSize")).toBe(false);
    vi.mocked(analyticsApi.fetchAnalytics).mockImplementationOnce((_parameters, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
    view.rerender(<Probe search="new filter" />);
    expect(screen.getByText("Loading")).toBeTruthy();
    view.unmount();
    await act(async () => undefined);
    expect(vi.mocked(analyticsApi.fetchAnalytics).mock.calls.at(-1)![1].aborted).toBe(true);
  });
});
