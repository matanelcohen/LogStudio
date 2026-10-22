import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageSizeControl } from "./PageSizeControl";

describe("page size input", () => {
  it("commits an arbitrary valid size on Enter or blur", () => {
    const changed = vi.fn();
    render(<PageSizeControl value={250} onChange={changed} />);
    const input = screen.getByLabelText("Rows per page");
    fireEvent.change(input, { target: { value: "1001" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changed).toHaveBeenCalledWith(1001);
    fireEvent.change(input, { target: { value: "50000" } });
    fireEvent.blur(input);
    expect(changed).toHaveBeenCalledWith(50000);
    fireEvent.change(input, { target: { value: "2147483647" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changed).toHaveBeenCalledWith(2147483647);
  });

  it("rejects invalid values and preserves the active page size", () => {
    const changed = vi.fn();
    render(<PageSizeControl value={250} onChange={changed} />);
    const input = screen.getByLabelText("Rows per page");
    for (const value of ["", "0", "-1", "2147483648", "1.5"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert").textContent).toContain("1–2147483647");
    }
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    if (!(input instanceof HTMLInputElement)) throw new Error("The page-size input is missing.");
    expect(input.value).toBe("250");
  });
});
