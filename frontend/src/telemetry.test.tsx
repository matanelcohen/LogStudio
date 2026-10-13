import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TelemetryWorkspace } from "./TelemetryWorkspace";
import { fetchTelemetry, readTelemetry, type MetricMeasurement, type TelemetrySnapshot, type TelemetrySpan } from "./telemetry-api";
import { chartPoints, MaximumDisplayedPoints, measurementScale, metricSeries, metricSeriesKey, recentMeasurements, spanRelation, telemetrySourceColor, traceGroups, traceWaterfall } from "./telemetry-model";

const metric: MetricMeasurement = {
  id: 1, timestamp: "2026-10-12T08:00:00Z", meter: "sample", name: "requests", unit: null,
  instrumentType: "Counter", value: 2, tags: [{ key: "route", value: "/home" }]
};
const span: TelemetrySpan = {
  id: 1, source: "sample", name: "request", traceId: "trace-1", spanId: "span-1", parentSpanId: "",
  startTime: metric.timestamp, durationMilliseconds: 3.5, kind: "Server", status: "Ok",
  statusDescription: null, tags: [], links: []
};
const empty: TelemetrySnapshot = { enabled: true, metrics: [], spans: [], droppedMetrics: 0, droppedSpans: 0 };
function response(snapshot: TelemetrySnapshot = empty) { return new Response(JSON.stringify(snapshot)); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe("telemetry contract", () => {
  it("validates the snapshot and uses the relative route and abort signal", async () => {
    const snapshot = { ...empty, metrics: [metric], spans: [span] };
    const fetch = vi.fn().mockResolvedValue(response(snapshot));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await fetchTelemetry(controller.signal)).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledWith("api/telemetry", { signal: controller.signal });
  });
  it.each([
    { enabled: "true" }, { droppedMetrics: -1 }, { droppedSpans: 0.5 }, { omittedMetrics: -1 }, { omittedSpans: "1" },
    { suppressedInstruments: -1 }, { suppressedInstruments: "1" }, { suppressedInstruments: 0.5 }, { suppressedInstruments: Number.MAX_SAFE_INTEGER + 1 }, { metrics: null },
    { metrics: Array.from({ length: 501 }, () => metric) },
    { spans: Array.from({ length: 501 }, () => span) },
    { metrics: [{ ...metric, value: Infinity }] }, { metrics: [{ ...metric, id: -1 }] },
    { metrics: [{ ...metric, timestamp: "bad" }] }, { metrics: [{ ...metric, unit: 5 }] },
    { metrics: [{ ...metric, tags: [{ key: "route", value: 5 }] }] },
    { metrics: [{ ...metric, name: "a".repeat(257) }] },
    { metrics: [{ ...metric, tags: Array.from({ length: 33 }, () => ({ key: "a", value: "b" })) }] },
    { metrics: [{ ...metric, tags: [{ key: "a".repeat(257), value: "b" }] }] },
    { metrics: [{ ...metric, tags: [{ key: "a", value: "b".repeat(257) }] }] },
    { spans: [{ ...span, source: "a".repeat(257) }] },
    { spans: [{ ...span, links: Array.from({ length: 17 }, () => ({ traceId: "trace", spanId: "span" })) }] },
    { spans: [{ ...span, links: [{ traceId: "a".repeat(257), spanId: "span" }] }] },
    { spans: [{ ...span, durationMilliseconds: -1 }] }, { spans: [{ ...span, links: [{ traceId: 42, spanId: "" }] }] }
  ])("rejects invalid payload %j", invalid => {
    expect(() => readTelemetry({ ...empty, ...invalid })).toThrow(/invalid telemetry/);
  });
  it("reports HTTP errors explicitly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(fetchTelemetry(new AbortController().signal)).rejects.toThrow("HTTP 404");
  });
  it("accepts optional snapshot omission counters separately from dropped records", () => {
    const snapshot = { ...empty, omittedMetrics: 20, omittedSpans: 10, suppressedInstruments: 2 };
    expect(readTelemetry(snapshot)).toEqual(snapshot);
  });
  it("accepts the backend bounds of 256 UTF-16 characters, 32 tags and 16 links", () => {
    const snapshot = { ...empty,
      metrics: [{ ...metric, name: "a".repeat(256), tags: Array.from({ length: 32 }, () => ({ key: "a", value: "b" })) }],
      spans: [{ ...span, links: Array.from({ length: 16 }, () => ({ traceId: "trace", spanId: "span" })) }]
    };
    expect(readTelemetry(snapshot)).toEqual(snapshot);
  });
});

describe("native measurement series and trace relations", () => {
  it("keeps meters, names, units, instruments and different tags separate", () => {
    const variants = [metric, { ...metric, meter: "other" }, { ...metric, name: "other" },
      { ...metric, unit: "ms" }, { ...metric, instrumentType: "Histogram" },
      { ...metric, tags: [{ key: "route", value: "/other" }] }];
    expect(metricSeries(variants)).toHaveLength(6);
    const tags = [{ key: "a", value: "1" }, { key: "b", value: "2" }];
    expect(metricSeriesKey({ ...metric, tags })).toBe(metricSeriesKey({ ...metric, tags: [...tags].reverse() }));
  });
  it("assigns stable, bounded source colors without interpolating telemetry into CSS", () => {
    for (const source of ["Orders.Api", "", "<script>unsafe</script>", "a".repeat(256)]) {
      expect(telemetrySourceColor(source)).toMatch(/^var\(--telemetry-series-[1-5]\)$/);
      expect(telemetrySourceColor(source)).toBe(telemetrySourceColor(source));
    }
  });
  it("bounds chart points, handles constants and negative/extreme values without invented aggregates", () => {
    const constant = chartPoints([{ ...metric, value: -5 }]);
    expect(constant[0]?.y).toBe(75);
    const extreme = chartPoints([metric, { ...metric, id: 2, value: Number.MAX_VALUE }, { ...metric, id: 3, value: -Number.MAX_VALUE }]);
    expect(extreme.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(chartPoints(Array.from({ length: 500 }, (_, index) => ({ ...metric, id: index })))).toHaveLength(MaximumDisplayedPoints);
    expect(chartPoints([])).toEqual([]);
  });
  it("groups by trace and identifies roots, retained parents and missing parents without recursive cycles", () => {
    const child = { ...span, id: 2, name: "child", spanId: "span-2", parentSpanId: span.spanId };
    const missing = { ...child, parentSpanId: "not-retained" };
    expect(traceGroups([span, child, { ...span, id: 3, traceId: "other" }])).toHaveLength(2);
    expect(spanRelation(span, [span])).toBe("Root span");
    expect(spanRelation({ ...span, parentSpanId: "0000000000000000" }, [span])).toBe("Root span");
    expect(spanRelation(child, [span, child])).toContain("Parent: request (span-1)");
    expect(spanRelation(missing, [span, missing])).toContain("Missing parent");
    expect(spanRelation(child, [{ ...span, traceId: "other" }, child])).toContain("Missing parent");
  });
  it("retains duplicate timestamps and orders the bounded raw chart window without aggregating", () => {
    const points = recentMeasurements([metric, { ...metric, id: 2, value: 5 },
      { ...metric, id: 3, timestamp: "2026-10-12T07:00:00Z", value: -2 }]);
    expect(points.map(point => point.value)).toEqual([-2, 2, 5]);
    expect(recentMeasurements(Array.from({ length: 500 }, (_, id) => ({ ...metric, id })))).toHaveLength(100);
    for (const values of [[-Number.MAX_VALUE, Number.MAX_VALUE], [Number.MIN_VALUE], [0], [-5, -5]]) {
      const metrics = values.map(value => ({ ...metric, value }));
      const scale = measurementScale(metrics);
      expect(scale).toBeGreaterThan(0);
      expect(metrics.every(point => Number.isFinite(point.value / scale))).toBe(true);
    }
  });
  it("builds nested waterfalls by actual start/end times, retaining orphans and cycles once", () => {
    const child = { ...span, id: 2, spanId: "child", parentSpanId: span.spanId,
      startTime: "2026-10-12T08:00:00.002Z", durationMilliseconds: 1 };
    const root = { ...span, durationMilliseconds: 10 };
    const orphan = { ...span, id: 3, spanId: "orphan", parentSpanId: "not-retained", durationMilliseconds: 0 };
    const result = traceWaterfall([child, orphan, root]);
    expect(result.duration).toBe(10);
    expect(result.rows.map(row => [row.span.id, row.depth])).toEqual([[1, 0], [2, 1], [3, 0]]);
    expect(result.rows[1]).toMatchObject({ startPercent: 20, widthPercent: 10 });
    const cycle = traceWaterfall([{ ...span, parentSpanId: "child" }, child]);
    expect(cycle.rows).toHaveLength(2);
    expect(traceWaterfall([])).toEqual({ rows: [], duration: 0 });
    const extreme = traceWaterfall([{ ...span, durationMilliseconds: Number.MAX_VALUE }, child]);
    expect(Number.isFinite(extreme.duration)).toBe(true);
    expect(extreme.rows.every(row => Number.isFinite(row.startPercent) && Number.isFinite(row.widthPercent))).toBe(true);
  });
});

describe("telemetry workspace lifecycle", () => {
  it("starts loading and polls only after a request settles, then aborts on unmount", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    const { unmount } = render(<TelemetryWorkspace view="metrics" archived={false} />);
    expect(screen.getByRole("status").textContent).toBe("Loading telemetry…");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(response());
    await flush();
    expect(screen.getByRole("status").textContent).toContain("No metric measurements");
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(2);
    const signal = fetch.mock.calls[1]?.[1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    resolve(response({ ...empty, metrics: [metric] }));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("never polls archived sessions or presents current-run telemetry as saved data", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ...empty, metrics: [metric] }));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<TelemetryWorkspace view="metrics" archived />);
    expect(screen.getByRole("status").textContent).toContain("not saved with sessions");
    expect(fetch).not.toHaveBeenCalled();
    rerender(<TelemetryWorkspace view="metrics" archived={false} />);
    await screen.findByText("2", { selector: ".metric-latest strong" });
    const signal = fetch.mock.calls[0]?.[1].signal as AbortSignal;
    rerender(<TelemetryWorkspace view="metrics" archived />);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText(/Latest raw measurement/)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts the previous view when navigating and cancels scheduled polling", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response()));
    vi.stubGlobal("fetch", fetch);
    const { rerender, unmount } = render(<TelemetryWorkspace view="metrics" archived={false} />);
    await flush();
    const signal = fetch.mock.calls[0]?.[1].signal as AbortSignal;
    rerender(<TelemetryWorkspace view="traces" archived={false} />);
    await flush();
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toContain("No completed spans");
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("shows disabled capture and transient errors, and recovers on the next poll", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(response({ ...empty, enabled: false }));
    vi.stubGlobal("fetch", fetch);
    render(<TelemetryWorkspace view="metrics" archived={false} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Offline");
    expect(screen.getByText("Reconnecting")).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("capture is disabled");
    expect(screen.getByText("Capture disabled")).toBeDefined();
  });
  it("provides native charts and exact raw table values with bounded series", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      ...empty, omittedMetrics: 20, omittedSpans: 10, droppedMetrics: 3, suppressedInstruments: 2,
      metrics: Array.from({ length: 20 }, (_, index) => ({ ...metric, id: index, value: -index, tags: [{ key: "route", value: `/${index}` }] }))
    })));
    render(<TelemetryWorkspace view="metrics" archived={false} />);
    await screen.findByText("-19", { selector: ".metric-latest strong" });
    expect(screen.getAllByRole("img")).toHaveLength(12);
    expect(screen.getByText(/Showing 12 of 20 series/)).toBeDefined();
    expect(screen.getByText(/Older retained records not shown: 20 measurements · 10 spans/).textContent).toContain("Dropped/expired: 3 measurements");
    expect(screen.getByText(/Instruments refused at capture limit: 2/).textContent).toContain("their future measurements are not counted as dropped");
    fireEvent.click(screen.getAllByText(/Raw measurement table/)[0]!);
    expect(screen.getAllByRole("table")).toHaveLength(12);
    expect(screen.getByRole("cell", { name: "-19" })).toBeDefined();
  });
  it("searches every metric series before the panel limit and combines search with source filtering", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...empty, metrics: [
      { ...metric, name: "cache.duration", meter: "Cache", instrumentType: "Histogram", unit: "ms",
        tags: [{ key: "region", value: "eu-west" }] },
      ...Array.from({ length: 20 }, (_, index) => ({ ...metric, id: index + 2, name: `requests.${index}` }))
    ] })));
    render(<TelemetryWorkspace view="metrics" archived={false} />);
    await screen.findByText("requests.19", { selector: "h3" });
    expect(screen.getAllByRole("img")).toHaveLength(12);
    expect(screen.queryByRole("heading", { name: "cache.duration" })).toBeNull();
    const search = screen.getByRole("searchbox", { name: "Search metrics" });
    for (const query of ["CACHE.DURATION", "cache", "histogram", "ms", "region", "EU-WEST"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getAllByRole("img")).toHaveLength(1);
      expect(screen.getByRole("heading", { name: "cache.duration" })).toBeDefined();
    }
    fireEvent.change(screen.getByRole("combobox", { name: "Metric source" }), { target: { value: "sample" } });
    expect(screen.getByRole("status").textContent).toContain("No metrics match these filters");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getAllByRole("img")).toHaveLength(12);
    const summary = screen.getByLabelText("Metric snapshot summary");
    expect(within(summary).getAllByText("21", { selector: "strong" })).toHaveLength(2);
    expect(within(summary).getByText("2", { selector: "strong" })).toBeDefined();
  });
  it("shows trace-specific snapshot counts instead of unrelated metric totals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...empty, metrics: [metric], spans: [
      span, { ...span, id: 2, spanId: "child", parentSpanId: span.spanId, status: "Error", source: "Database" }
    ] })));
    render(<TelemetryWorkspace view="traces" archived={false} />);
    const summary = await screen.findByLabelText("Trace snapshot summary");
    expect(within(summary).getByText("Recent traces")).toBeDefined();
    expect(within(summary).getByText("Error spans")).toBeDefined();
    expect(within(summary).getAllByText("1", { selector: "strong" })).toHaveLength(2);
    expect(within(summary).getAllByText("2", { selector: "strong" })).toHaveLength(2);
    expect(within(summary).queryByText("Measurements")).toBeNull();
  });
  it("selects span details safely and includes parent relationships, duration, status, tags and links", async () => {
    const child = { ...span, id: 2, name: "<script>unsafe</script>", spanId: "span-2", parentSpanId: span.spanId,
      status: "Error", statusDescription: "failed", tags: [{ key: "route", value: "<b>raw</b>" }],
      links: [{ traceId: "linked-trace", spanId: "linked-span" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...empty, spans: [span, child] })));
    const { container } = render(<TelemetryWorkspace view="traces" archived={false} />);
    const button = await screen.findByRole("button", { name: /unsafe.*3.5 ms.*Error/ });
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Selected span details" })).toBeDefined();
    expect(screen.getByText("Error: failed")).toBeDefined();
    expect(screen.getByText("<b>raw</b>")).toBeDefined();
    expect(screen.getByText(/Trace linked-trace · Span linked-span/)).toBeDefined();
    expect(screen.getAllByText("Parent: request (span-1)")).toHaveLength(2);
    expect(container.querySelector("script")).toBeNull();
  });
});
