import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TraceExplorer } from "./TraceExplorer";
import type { TelemetrySpan } from "./telemetry-api";

const root: TelemetrySpan = {
  id: 1, source: "Orders.Api", name: "POST /orders", traceId: "trace-one", spanId: "root", parentSpanId: "",
  startTime: "2026-10-12T08:00:00Z", durationMilliseconds: 100, kind: "Server", status: "Ok",
  statusDescription: null, tags: [{ key: "route", value: "/orders" }], links: []
};
const child = { ...root, id: 2, name: "SELECT orders", spanId: "child", parentSpanId: "root",
  startTime: "2026-10-12T08:00:00.020Z", durationMilliseconds: 30, status: "Error", statusDescription: "timeout" };
const other = { ...root, id: 3, name: "GET /health", traceId: "trace-two", spanId: "health", source: "Health.Api", tags: [] };

describe("trace explorer", () => {
  it("searches all retained traces before limiting the list, using IDs, names, sources, status and tags", () => {
    const spans = Array.from({ length: 60 }, (_, index) => ({ ...other, id: index + 3, traceId: `health-${index}` }));
    render(<TraceExplorer spans={[root, child, ...spans]} />);
    expect(within(screen.getByRole("region", { name: "Trace list" })).getAllByRole("button")).toHaveLength(50);
    const search = screen.getByRole("searchbox", { name: "Search traces" });
    for (const query of ["TRACE-ONE", "select", "orders.api", "error", "/orders"]) {
      fireEvent.change(search, { target: { value: query } });
      const list = screen.getByRole("region", { name: "Trace list" });
      expect(within(list).getAllByRole("button")).toHaveLength(1);
      expect(within(list).getByText("trace-one")).toBeDefined();
    }
    fireEvent.change(search, { target: { value: "absent" } });
    expect(screen.getByRole("status").textContent).toContain("No traces match");
    expect(screen.queryByRole("region", { name: "Selected span details" })).toBeNull();
  });
  it("selects traces and spans, collapses descendants and positions timing bars", () => {
    render(<TraceExplorer spans={[root, child, other]} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Trace list" })).getByRole("button", { name: /POST \/orders/ }));
    const waterfall = screen.getByRole("region", { name: "Span waterfall" });
    expect(within(waterfall).getByRole("button", { name: /SELECT orders · 30 ms · Error/ })).toBeDefined();
    const bar = within(waterfall).getByRole("button", { name: "Inspect span child" }).firstElementChild as HTMLElement;
    expect(bar.style.left).toBe("20%");
    expect(bar.style.width).toBe("30%");
    fireEvent.click(screen.getByRole("button", { name: "Collapse POST /orders" }));
    expect(within(waterfall).queryByRole("button", { name: /SELECT orders ·/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand POST /orders" }));
    fireEvent.click(within(waterfall).getByRole("button", { name: /SELECT orders · 30 ms/ }));
    const inspector = screen.getByRole("region", { name: "Selected span details" });
    expect(within(inspector).getByText("Error: timeout")).toBeDefined();
    expect(within(inspector).getByText("Parent: POST /orders (root)")).toBeDefined();
  });
  it("keeps the active trace on polling and reports expired selections without stale details", () => {
    const { rerender } = render(<TraceExplorer spans={[root, child]} />);
    fireEvent.click(screen.getByRole("button", { name: /SELECT orders · 30 ms/ }));
    rerender(<TraceExplorer spans={[root, child, other]} />);
    expect(screen.getByRole("region", { name: "Selected span details" }).textContent).toContain("SELECT orders");
    rerender(<TraceExplorer spans={[root, other]} />);
    expect(screen.getByRole("status").textContent).toContain("selected span has left");
    expect(screen.queryByRole("region", { name: "Selected span details" })).toBeNull();
  });
  it("keeps an explicitly selected retained trace visible when newer traces fill the list", () => {
    const { rerender } = render(<TraceExplorer spans={[root, child]} />);
    fireEvent.click(screen.getByRole("button", { name: /SELECT orders · 30 ms/ }));
    const newer = Array.from({ length: 60 }, (_, index) => ({ ...other, id: index + 3, traceId: `new-${index}` }));
    rerender(<TraceExplorer spans={[root, child, ...newer]} />);
    const list = screen.getByRole("region", { name: "Trace list" });
    expect(within(list).getAllByRole("button")).toHaveLength(50);
    expect(within(list).getByRole("button", { name: /POST \/orders/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Selected span details" }).textContent).toContain("SELECT orders");
  });
  it("filters errors and sorts by retained duration before limiting the trace list", () => {
    const newer = Array.from({ length: 60 }, (_, index) => ({ ...other, id: index + 3, traceId: `health-${index}`,
      durationMilliseconds: index + 1 }));
    render(<TraceExplorer spans={[root, child, ...newer]} />);
    const status = screen.getByRole("combobox", { name: "Trace status" });
    const list = () => screen.getByRole("region", { name: "Trace list" });
    expect(within(list()).queryByText("trace-one")).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Sort traces" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("option", { name: "Longest first" }), { key: "Enter" });
    expect(within(list()).getAllByRole("button")[0]?.textContent).toContain("POST /orders");
    fireEvent.keyDown(status, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("option", { name: "With errors" }), { key: "Enter" });
    expect(within(list()).getAllByRole("button")).toHaveLength(1);
    expect(within(list()).getByText("trace-one")).toBeDefined();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search traces" }), { target: { value: "health" } });
    expect(screen.getByRole("status").textContent).toContain("No traces match");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(within(list()).getAllByRole("button")[0]?.textContent).toContain("health-59");
    fireEvent.keyDown(status, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("option", { name: "No retained errors" }), { key: "Enter" });
    expect(within(list()).queryByText("trace-one")).toBeNull();
    expect(screen.getByText("Showing 50 of 60 matching traces.")).toBeDefined();
  });
  it("uses consistent source colors in the waterfall and names error states explicitly", () => {
    render(<TraceExplorer spans={[root, { ...child, source: "Orders.Database" }]} />);
    const legend = screen.getByLabelText("Span sources");
    expect(within(legend).getByText("Orders.Api")).toBeDefined();
    expect(within(legend).getByText("Orders.Database")).toBeDefined();
    expect(within(legend).getByText("1 error spans")).toBeDefined();
    const selected = screen.getByRole("button", { name: "Inspect span child" }).closest("li")!;
    expect(selected.classList.contains("error")).toBe(true);
    expect((selected as HTMLElement).style.getPropertyValue("--telemetry-series-color")).toMatch(/var\(--telemetry-series-/);
  });
});
