import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { TerminalInput } from "./TerminalInput";

describe("terminal input", () => {
  it.each(["  hello 世界 👋  ", "", "\t"])("sends a line unchanged and clears only after success: %j", async text => {
    const send = vi.spyOn(api, "sendInput").mockResolvedValue();
    render(<TerminalInput />);
    const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(screen.getByRole("form", { name: "Send terminal input" }));
    await screen.findByText("Input sent.");
    expect(send).toHaveBeenCalledExactlyOnceWith(text);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("prevents duplicate submissions while a request is pending", async () => {
    let finish!: () => void;
    const send = vi.spyOn(api, "sendInput").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<TerminalInput />);
    const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "answer" } });
    const form = screen.getByRole("form", { name: "Send terminal input" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: "Sending…" }).hasAttribute("disabled")).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("answer");
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await screen.findByText("Input sent.");
    expect(input.readOnly).toBe(false);
  });

  it("retains failed input with an explicit warning and never retries automatically", async () => {
    const send = vi.spyOn(api, "sendInput").mockRejectedValue(new Error("The program's input is closed."));
    render(<TerminalInput />);
    const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send input" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("input is closed"));
    expect(screen.getByRole("alert").textContent).toContain("Check the program output before retrying");
    expect(input.value).toBe("keep this");
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Input sent.")).toBeNull();
  });
});
