import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultQuery } from "./model";
import { QueryBar } from "./QueryBar";
import { fixturePage } from "./test-fixtures";

describe("export menu", () => {
  it("distinguishes the complete selected session from matching records", async () => {
    render(<QueryBar query={{ ...defaultQuery(), sessionId: "saved", search: "error" }} page={fixturePage()}
      loading={false} error={null} searchRef={createRef()} maximumId={100}
      onChange={vi.fn()} onEdit={vi.fn()} onReset={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText("Export options"), { key: "Enter" });
    const bundle = await screen.findByRole("menuitem", { name: /Portable session bundle/ });
    const filtered = screen.getByRole("menuitem", { name: /Matching records/ });
    expect(bundle.getAttribute("href")).toBe("api/export-session?sessionId=saved");
    expect(filtered.getAttribute("href")).toContain("q=error");
    expect(filtered.getAttribute("href")).toContain("sessionId=saved");
    expect(filtered.getAttribute("href")).toContain("maxId=100");
    const csv = screen.getByRole("menuitem", { name: /Spreadsheet/ });
    expect(csv.getAttribute("href")).toContain("format=csv");
    expect(csv.getAttribute("href")).toContain("sessionId=saved");
    expect(csv.getAttribute("href")).toContain("maxId=100");
  });

  it("disables CSV export while a query is loading or has no matches", async () => {
    render(<QueryBar query={defaultQuery()} page={fixturePage()} loading error={null} searchRef={createRef()} maximumId={null}
      onChange={vi.fn()} onEdit={vi.fn()} onReset={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText("Export options"), { key: "Enter" });
    expect((await screen.findByRole("menuitem", { name: /Spreadsheet/ })).getAttribute("aria-disabled")).toBe("true");
  });

  it("clears exact bounds when a relative time window is chosen", async () => {
    const change = vi.fn();
    render(<QueryBar query={{ ...defaultQuery(), since: "2026-10-11T18:00:00Z", until: "2026-10-11T18:01:00Z" }}
      page={fixturePage()} loading={false} error={null} searchRef={createRef()} maximumId={null}
      onChange={change} onEdit={vi.fn()} onReset={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Time window" }), { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name: "Last minute" }), { key: "Enter" });
    expect(change).toHaveBeenCalledWith({ ...defaultQuery(), timeWindow: 60000 });
  });
});
