import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultQuery } from "./model";
import { TimeRangeControl } from "./TimeRangeControl";

describe("exact time range", () => {
  it("converts local bounds to UTC without losing milliseconds and replaces relative windows", () => {
    const change = vi.fn();
    render(<TimeRangeControl query={{ ...defaultQuery(), timeWindow: 60000 }} onChange={change} />);
    fireEvent.click(screen.getByRole("button", { name: "Set exact time range" }));
    fireEvent.change(screen.getByLabelText("Start (local time)"), { target: { value: "2026-10-11T18:00:00.123" } });
    fireEvent.change(screen.getByLabelText("End (local time)"), { target: { value: "2026-10-11T18:01:00.456" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
    expect(change).toHaveBeenCalledWith({
      ...defaultQuery(), since: new Date("2026-10-11T18:00:00.123").toISOString(), until: new Date("2026-10-11T18:01:00.456").toISOString()
    });
  });

  it("keeps invalid ranges unapplied and supports open bounds and clearing", () => {
    const change = vi.fn();
    function Harness() {
      const [query, setQuery] = useState(defaultQuery);
      return <TimeRangeControl query={query} onChange={query => { change(query); setQuery(query); }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Set exact time range" }));
    fireEvent.change(screen.getByLabelText("Start (local time)"), { target: { value: "2026-10-12T18:00" } });
    fireEvent.change(screen.getByLabelText("End (local time)"), { target: { value: "2026-10-11T18:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
    expect(screen.getByRole("alert").textContent).toContain("Start must be");
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Start (local time)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
    expect(change.mock.lastCall?.[0].since).toBe("");
    expect(screen.getByRole("button", { name: "Set exact time range" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Set exact time range" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear range" }));
    expect(change).toHaveBeenLastCalledWith(defaultQuery());
  });
});
