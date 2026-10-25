import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type uPlot from "uplot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChart } from "./MetricChart";
import { useAppearance } from "./useAppearance";
import type { MetricMeasurement } from "./telemetry-api";

const { instances, constructor } = vi.hoisted(() => {
  const instances: {
    options: uPlot.Options; data: uPlot.AlignedData;
    cursor: { left: number; top: number; idxs: (number | null)[] }; select: { width: number };
    scales: { x: { min: number; max: number } };
    setData: ReturnType<typeof vi.fn>; setSize: ReturnType<typeof vi.fn>;
    setScale: ReturnType<typeof vi.fn>; setCursor: ReturnType<typeof vi.fn>;
    redraw: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>; posToVal: ReturnType<typeof vi.fn>; valToPos: ReturnType<typeof vi.fn>;
  }[] = [];
  const constructor = vi.fn(function(options: uPlot.Options, data: uPlot.AlignedData) {
    const chart = {
      options, data, cursor: { left: 0, top: 0, idxs: [null, null] as (number | null)[] }, select: { width: 0 },
      scales: { x: { min: 0, max: 1 } },
      setData: vi.fn(), setSize: vi.fn(), setScale: vi.fn(), setCursor: vi.fn(), redraw: vi.fn(), destroy: vi.fn(),
      posToVal: vi.fn(), valToPos: vi.fn((value: number) => value)
    };
    instances.push(chart);
    return chart;
  });
  return { instances, constructor };
});
vi.mock("uplot", () => ({ default: Object.assign(constructor, { paths: { linear: () => vi.fn() } }) }));

const metric: MetricMeasurement = {
  id: 1, timestamp: "2026-10-12T08:00:00Z", meter: "Orders.Api", name: "latency", unit: "ms",
  instrumentType: "Histogram", value: 5, tags: []
};

describe("metric chart lifecycle and interaction", () => {
  beforeEach(() => {
    instances.length = 0;
    constructor.mockClear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 480, height: 210, top: 0, right: 480, bottom: 210, left: 0, toJSON: () => ({})
    });
  });
  it("uses faceted data to preserve equal timestamps and safely normalizes extreme values", () => {
    render(<MetricChart metrics={[{ ...metric, value: -Number.MAX_VALUE }, { ...metric, id: 2, value: Number.MAX_VALUE }]} />);
    const chart = instances[0]!;
    expect(chart.options.mode).toBe(2);
    expect(chart.data).toEqual([null, [[Date.parse(metric.timestamp) / 1000, Date.parse(metric.timestamp) / 1000], [-1, 1]]]);
    chart.posToVal.mockReturnValue(Date.parse(metric.timestamp) / 1000);
    chart.cursor.top = 1;
    expect(chart.options.cursor!.dataIdx!(chart as unknown as uPlot, 1, 0, 0)).toBe(1);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("raw measurements; values in table below");
  });
  it("updates a mounted plot without losing a selected time window, and resets zoom explicitly", () => {
    const { rerender, unmount } = render(<MetricChart metrics={[metric]} />);
    const chart = instances[0]!;
    chart.select.width = 50;
    chart.options.hooks!.setSelect![0]!(chart as unknown as uPlot);
    rerender(<MetricChart metrics={[metric, { ...metric, id: 2, value: 10 }]} />);
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(chart.setData.mock.calls.at(-1)?.[1]).toBe(false);
    expect(chart.redraw).toHaveBeenCalledWith(true, true);
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(chart.setData.mock.calls.at(-1)).toHaveLength(1);
    unmount();
    expect(chart.destroy).toHaveBeenCalledTimes(1);
  });
  it("exposes exact values via hover and keyboard inspection, including markup as plain text", () => {
    const { container } = render(<MetricChart metrics={[metric, { ...metric, id: 2, value: 7, unit: "<b>ms</b>" }]} />);
    const chart = instances[0]!;
    chart.cursor.idxs[1] = 1;
    act(() => chart.options.hooks!.setCursor![0]!(chart as unknown as uPlot));
    expect(screen.getByText(`${metric.timestamp} · 7 <b>ms</b>`)).toBeDefined();
    fireEvent.keyDown(screen.getByRole("img"), { key: "ArrowLeft" });
    expect(screen.getByText(`${metric.timestamp} · 5 <b>ms</b>`)).toBeDefined();
    expect(chart.setCursor).toHaveBeenCalled();
    expect(container.querySelector("b")).toBeNull();
  });
  it("resizes the existing plot and recreates its colors on theme changes", async () => {
    let onResize!: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { onResize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const { unmount } = render(<MetricChart metrics={[metric]} />);
    const chart = instances[0]!;
    act(() => onResize([{ contentRect: { width: 320 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(chart.setSize).toHaveBeenCalledWith({ width: 320, height: 210 });
    await act(async () => { document.documentElement.dataset.theme = "dark"; });
    expect(chart.destroy).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledTimes(2);
    unmount();
    expect(disconnect).toHaveBeenCalled();
    delete document.documentElement.dataset.theme;
  });
  it("refreshes colors and preserves zoom when switching between two dark palettes", async () => {
    const appearance = renderHook(useAppearance);
    act(() => appearance.result.current.setAppearance("dark-modern"));
    const { unmount } = render(<MetricChart metrics={[metric]} />);
    const chart = instances[0]!;
    chart.select.width = 50;
    chart.scales.x = { min: 100, max: 200 };
    act(() => chart.options.hooks!.setSelect![0]!(chart as unknown as uPlot));
    await act(async () => appearance.result.current.setAppearance("monokai"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(chart.destroy).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledTimes(2);
    expect(instances[1]!.setScale).toHaveBeenCalledWith("x", { min: 100, max: 200 });
    unmount();
    appearance.unmount();
    history.replaceState(null, "", "/");
  });
});
