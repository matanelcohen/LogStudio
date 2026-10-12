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
  });
});
