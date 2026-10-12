import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClearHistoryDialog } from "./ClearHistoryDialog";

describe("destructive session clear", () => {
  it("requires an explicit confirmation and describes session-wide deletion", () => {
    const confirm = vi.fn();
    const close = vi.fn();
    render(<ClearHistoryDialog open entryCount={10000} deleting={false} error={null}
      onConfirm={confirm} onClose={close} returnFocus={vi.fn()} />);
    expect(screen.getByText(/every tab connected/).textContent).toContain("disk");
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel"));
    expect(close).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete session logs"));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("disables repeated confirmation and surfaces deletion failures", () => {
    const confirm = vi.fn();
    render(<ClearHistoryDialog open entryCount={2} deleting error="disk could not be cleared"
      onConfirm={confirm} onClose={vi.fn()} returnFocus={vi.fn()} />);
    fireEvent.click(screen.getByText("Deleting…"));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("disk could not be cleared");
  });
});
