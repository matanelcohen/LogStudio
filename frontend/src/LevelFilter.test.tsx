import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { LevelFilter } from "./LevelFilter";
import type { Severity } from "./model";

function Harness() {
  const [value, setValue] = useState<Severity[] | null>(null);
  return <><LevelFilter value={value} onChange={setValue} /><output aria-label="selected-levels">{JSON.stringify(value)}</output></>;
}

describe("multiple log levels", () => {
  it("keeps the menu open to select Info and Error together", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Level" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Info" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Error" }));
    expect(screen.getByLabelText("selected-levels").textContent).toBe('["information","error"]');
    expect(trigger.textContent).toContain("Info + Error");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Info" }));
    expect(screen.getByLabelText("selected-levels").textContent).toBe('["error"]');
  });

  it("supports all levels and explicitly no levels", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Level" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Info" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "All levels" }));
    expect(screen.getByLabelText("selected-levels").textContent).toBe("null");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "All levels" }));
    expect(screen.getByLabelText("selected-levels").textContent).toBe("[]");
    expect(trigger.textContent).toContain("No levels");
  });
});
