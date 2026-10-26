import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { SurroundingEntries } from "./SurroundingEntries";
import { Entry, Status } from "./test-fixtures";
import type { ContextPage } from "./model";

const location = { sessionId: "11111111111111111111111111111111", entryId: 1000 };
function contextPage(start = 975, count = 51): ContextPage {
  return {
    sessionId: location.sessionId, anchorId: location.entryId, status: Status, filtersBypassed: true,
    entries: Array.from({ length: count }, (_, index) => ({ ...Entry, id: start + index, message: `Context ${start + index}` })),
    before: start, after: start + count - 1
  };
}

describe("surrounding entries", () => {
  it("highlights the anchor outside the first results page, supports arrows, and replaces bounded pages", async () => {
    const fetch = vi.spyOn(api, "fetchContext").mockResolvedValueOnce(contextPage()).mockResolvedValue(contextPage(950, 25));
    const onClose = vi.fn();
    render(<SurroundingEntries location={location} unavailable={null} onClose={onClose} returnFocus={vi.fn()} />);
    const table = await screen.findByRole("table", { name: "Surrounding logs" });
    expect(screen.getByText(/Active filters are bypassed/)).toBeTruthy();
    expect(table.querySelectorAll("tbody tr")).toHaveLength(51);
    const anchor = table.querySelector<HTMLElement>('[data-context-id="1000"]')!;
    expect(anchor.getAttribute("data-anchor")).toBe("true");
    act(() => anchor.focus());
    fireEvent.keyDown(anchor, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("data-context-id")).toBe("999");
    expect(table.querySelector('[data-context-id="999"]')?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Load 25 older entries" }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(location, { before: 975, after: null }, expect.any(AbortSignal)));
    await screen.findByText("Context 950");
    expect(screen.queryByText("Context 1000")).toBeNull();
    expect(screen.getByRole("table", { name: "Surrounding logs" }).querySelectorAll("tbody tr")).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Return to results" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([["cleared", 410], ["expired", 410], ["deleted session", 404]])("reconciles an anchor %s during inspection", async (reason, status) => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(api, "fetchContext").mockResolvedValueOnce(contextPage())
      .mockRejectedValue(new api.ApiError(reason, status));
    render(<SurroundingEntries location={location} unavailable={null} onClose={vi.fn()} returnFocus={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Context 1000")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toContain(reason);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Return to results" })).toBeTruthy();
  });

  it("aborts stale reads and never replaces context with a newly selected application's IDs", async () => {
    let resolve: (page: ContextPage) => void = () => undefined;
    const fetch = vi.spyOn(api, "fetchContext").mockImplementation(() => new Promise(done => { resolve = done; }));
    const props = { location, unavailable: null as string | null, onClose: vi.fn(), returnFocus: vi.fn() };
    const view = render(<SurroundingEntries {...props} />);
    const signal = fetch.mock.calls[0]![2];
    view.rerender(<SurroundingEntries {...props} unavailable="The active application changed." />);
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(contextPage()));
    expect(screen.getByRole("alert").textContent).toContain("active application changed");
    expect(screen.queryByRole("table")).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(within(screen.getByRole("dialog")).getByText(`Session ${location.sessionId}`)).toBeTruthy();
  });
});
