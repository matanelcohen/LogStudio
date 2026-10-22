import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimeFormatter } from "./model";
import { Entry } from "./test-fixtures";
import { VisiblePageChart } from "./VisiblePageChart";

describe("visible-page time distribution", () => {
  it("does not render a chart for an empty page", () => {
    render(<VisiblePageChart entries={[]} />);
    expect(screen.queryByRole("region", { name: "Visible-page time distribution" })).toBeNull();
  });

  it("buckets out-of-order timestamps using the full time range", () => {
    const first = "2026-10-11T18:00:00Z";
    const middle = "2026-10-11T18:00:08Z";
    const last = "2026-10-11T18:00:16Z";
    const { container } = render(<VisiblePageChart entries={[
      { ...Entry, timestamp: last }, { ...Entry, timestamp: first }, { ...Entry, timestamp: middle }
    ]} />);
    const bars = container.querySelectorAll(".chart-bar");
    expect(bars).toHaveLength(16);
    expect([bars[0]?.getAttribute("title"), bars[8]?.getAttribute("title"), bars[15]?.getAttribute("title")])
      .toEqual(Array(3).fill("1 entries in this interval"));
    expect(screen.getByText(TimeFormatter.format(new Date(first)))).toBeDefined();
    expect(screen.getByText(TimeFormatter.format(new Date(last)))).toBeDefined();
  });

  it("renders pages larger than the JavaScript function argument limit", () => {
    render(<VisiblePageChart entries={Array.from({ length: 200000 }, () => Entry)} />);
    expect(screen.getByText("Visible page only · 200000 entries")).toBeDefined();
    expect(screen.getByTitle("200000 entries in this interval")).toBeDefined();
    expect(screen.getAllByTitle("0 entries in this interval")).toHaveLength(15);
  });
});
