import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConditionDialog } from "./ConditionDialog";
import type { LogCondition } from "./model";

const Existing: LogCondition[] = [{ mode: "exclude", field: "message", operator: "contains", value: "heartbeat" }];

describe("controlled query drafts", () => {
  it("keeps edits separate until applying and supports cancelling", () => {
    const apply = vi.fn();
    const close = vi.fn();
    render(<ConditionDialog open conditions={Existing} includeMode="all" seed={null} onApply={apply} onClose={close} />);
    fireEvent.change(screen.getByLabelText("Condition 1 value"), { target: { value: "new exclusion" } });
    expect(Existing[0]?.value).toBe("heartbeat");
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel"));
    expect(close).toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies validated draft definitions without leaking row identities", () => {
    const apply = vi.fn();
    render(<ConditionDialog open conditions={Existing} includeMode="any" seed={null} onApply={apply} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Condition 1 value"), { target: { value: "noise" } });
    fireEvent.submit(screen.getByText("Apply conditions").closest("form") ?? screen.getByText("Apply conditions"));
    expect(apply).toHaveBeenCalledWith([{ ...Existing[0], value: "noise" }], "any");
  });

  it("shows explicit validation instead of applying an empty rule", () => {
    const apply = vi.fn();
    render(<ConditionDialog open conditions={[]} includeMode="all" seed={null} onApply={apply} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Apply conditions"));
    expect(screen.getByRole("alert").textContent).toContain("Every condition needs a value");
    expect(apply).not.toHaveBeenCalled();
  });
});
