import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultQuery, sessionFilters } from "./model";
import { type SavedSearch } from "./preferences";
import { SavedSearchesDialog } from "./SavedSearchesDialog";

describe("saved searches", () => {
  const query = { ...defaultQuery(), search: "timeout", dismissedThrough: 100, sessionId: "saved", pageSize: 10 };
  function props() {
    return { open: true, query, searches: [], saved: true, saveError: null, onChange: vi.fn(), onApply: vi.fn(), onRetry: vi.fn(), onClose: vi.fn(), returnFocus: vi.fn() };
  }

  it("saves reusable filter snapshots, applies them and deletes them", () => {
    const callbacks = props();
    function Harness() {
      const [searches, setSearches] = useState<SavedSearch[]>([]);
      return <SavedSearchesDialog {...callbacks} searches={searches} onChange={searches => { setSearches(searches); callbacks.onChange(searches); }} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Search name"), { target: { value: "  Timeouts  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save current filters" }));
    expect(callbacks.onChange).toHaveBeenLastCalledWith([{ name: "Timeouts", filters: sessionFilters(query) }]);
    const saved = callbacks.onChange.mock.lastCall?.[0][0].filters;
    expect(saved).not.toHaveProperty("sessionId");
    expect(saved).not.toHaveProperty("pageSize");
    expect(saved).not.toHaveProperty("dismissedThrough");
    fireEvent.click(screen.getByRole("button", { name: "Timeouts" }));
    expect(callbacks.onApply).toHaveBeenCalledWith(sessionFilters(query));
    expect(callbacks.onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete saved search Timeouts" }));
    expect(callbacks.onChange).toHaveBeenLastCalledWith([]);
  });

  it("rejects duplicate names and enforces the search limit", () => {
    const callbacks = props();
    const searches = [{ name: "Timeouts", filters: sessionFilters(query) }];
    const { rerender } = render(<SavedSearchesDialog {...callbacks} searches={searches} />);
    fireEvent.change(screen.getByLabelText("Search name"), { target: { value: "timeouts" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current filters" }));
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    expect(callbacks.onChange).not.toHaveBeenCalled();
    rerender(<SavedSearchesDialog {...callbacks} searches={Array.from({ length: 10 }, (_, index) => ({ name: `Search ${index}`, filters: sessionFilters(query) }))} />);
    expect(screen.getByRole("button", { name: "Save current filters" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows disk save failures in the dialog and offers a retry", () => {
    const callbacks = props();
    render(<SavedSearchesDialog {...callbacks} saved={false} saveError="Could not autosave settings: disk full" />);
    expect(screen.getByRole("alert").textContent).toContain("disk full");
    expect(screen.getByText("Not saved to disk")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry settings" }));
    expect(callbacks.onRetry).toHaveBeenCalled();
  });
});
