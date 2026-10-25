import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";
import { Entry, Status } from "./test-fixtures";

function props() {
  return { entry: Entry, entries: [Entry], status: Status, onSelect: vi.fn(), onClose: vi.fn(), onCondition: vi.fn(), onDraft: vi.fn(), onNotice: vi.fn() };
}

describe("entry inspector", () => {
  it("formats JSON objects and arrays without changing copied messages or entry exports", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const entry = { ...Entry, message: '{"name":"demo","nested":[1,{"ok":true}]}' };
    const callbacks = props();
    render(<Inspector {...callbacks} entry={entry} entries={[entry]} />);
    expect(document.getElementById("detailMessage")?.textContent).toBe(entry.message);
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(document.getElementById("detailMessage")?.textContent).toBe(JSON.stringify(JSON.parse(entry.message), null, 2));
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenLastCalledWith(entry.message);
    await waitFor(() => expect(callbacks.onNotice).toHaveBeenCalledWith({ tone: "info", message: "Copied message from entry #1." }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(entry, null, 2));
    fireEvent.click(screen.getByRole("button", { name: "Include text…" }));
    expect(callbacks.onDraft).toHaveBeenCalledWith(expect.objectContaining({ value: entry.message }));
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(document.getElementById("detailMessage")?.textContent).toBe(entry.message);
  });

  it.each(["plain text", "{not json}", "null", '"string"'])("keeps %s messages raw", message => {
    render(<Inspector {...props()} entry={{ ...Entry, message }} />);
    expect(screen.queryByRole("button", { name: "Format JSON" })).toBeNull();
    expect(document.getElementById("detailMessage")?.textContent).toBe(message);
  });

  it("formats JSON arrays and renders embedded markup only as text", () => {
    const message = '[{"text":"<img src=x onerror=alert(1)>"}]';
    const { container } = render(<Inspector {...props()} entry={{ ...Entry, message }} />);
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(document.getElementById("detailMessage")?.textContent).toBe(JSON.stringify(JSON.parse(message), null, 2));
    expect(container.querySelector("img")).toBeNull();
  });

  it("preserves large IDs, numeric notation, duplicate keys and string escapes when formatting", () => {
    const message = '{"id":9007199254740993,"value":1e+30,"value":-0,"text":"quote\\\" and \\\\","empty":{}}';
    render(<Inspector {...props()} entry={{ ...Entry, message }} />);
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    const formatted = document.getElementById("detailMessage")?.textContent;
    expect(formatted).toContain('"id": 9007199254740993');
    expect(formatted).toContain('"value": 1e+30');
    expect(formatted).toContain('"value": -0');
    expect(formatted).toContain('"text": "quote\\\" and \\\\"');
    expect(formatted).toContain('"empty": {}');
  });

  it("keeps exceptionally deep JSON raw instead of expanding unbounded output", () => {
    const message = "[".repeat(65) + "1" + "]".repeat(65);
    render(<Inspector {...props()} entry={{ ...Entry, message }} />);
    expect(screen.queryByRole("button", { name: "Format JSON" })).toBeNull();
    expect(document.getElementById("detailMessage")?.textContent).toBe(message);
  });
  it("reports unavailable or rejected clipboard writes", async () => {
    const callbacks = props();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(<Inspector {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(callbacks.onNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger", message: expect.stringContaining("unavailable") }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) } });
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(callbacks.onNotice).toHaveBeenLastCalledWith({ tone: "danger", message: "Copy failed: Permission denied" }));
  });

  it("navigates only within the visible page and handles an expired selection", () => {
    const callbacks = props();
    const second = { ...Entry, id: 2 };
    const third = { ...Entry, id: 3 };
    const entries = [Entry, second, third];
    const { rerender } = render(<Inspector {...callbacks} entries={entries} />);
    expect(screen.getByRole("button", { name: "Previous entry" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next entry" }));
    expect(callbacks.onSelect).toHaveBeenLastCalledWith(second);
    rerender(<Inspector {...callbacks} entry={second} entries={entries} />);
    expect(screen.getByText("2 of 3 on page")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Previous entry" }));
    expect(callbacks.onSelect).toHaveBeenLastCalledWith(Entry);
    rerender(<Inspector {...callbacks} entry={third} entries={entries} />);
    expect(screen.getByRole("button", { name: "Next entry" }).hasAttribute("disabled")).toBe(true);
    rerender(<Inspector {...callbacks} entries={[second, third]} />);
    expect(screen.getByText("Selection outside current page")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next entry" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Previous entry" }).hasAttribute("disabled")).toBe(true);
  });
});
