import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { SessionImportDialog } from "./SessionImportDialog";
import type { SessionInfo } from "./model";

const Imported: SessionInfo = {
  id: "imported", name: "Imported investigation", startedAt: "2026-10-11T08:00:00Z",
  completedAt: "2026-10-11T08:01:00Z", exitCode: 0, entryCount: 20,
  command: "dotnet", arguments: ["run"], workingDirectory: "/fixture", isCurrent: false
};

afterEach(() => vi.restoreAllMocks());

describe("session file import", () => {
  it("imports a chosen file with an optional name and opens its new session", async () => {
    const imported = vi.fn();
    const upload = vi.spyOn(api, "importSessionFile").mockResolvedValue(Imported);
    render(<SessionImportDialog open onClose={vi.fn()} onImported={imported} returnFocus={vi.fn()} />);
    const file = new File(["fixture"], "run.logstudio.zip");
    fireEvent.change(screen.getByLabelText("Session file"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Imported session name"), { target: { value: "My investigation" } });
    fireEvent.click(screen.getByRole("button", { name: "Import and open" }));
    await waitFor(() => expect(imported).toHaveBeenCalledWith(Imported));
    expect(upload).toHaveBeenCalledWith(file, "My investigation", expect.any(Function));
  });

  it("shows upload and validation states and prevents closing while busy", async () => {
    const closed = vi.fn();
    let finish: ((session: SessionInfo) => void) | undefined;
    let report: ((percent: number) => void) | undefined;
    vi.spyOn(api, "importSessionFile").mockImplementation((_file, _name, progress) => {
      report = progress;
      return new Promise(resolve => { finish = resolve; });
    });
    render(<SessionImportDialog open onClose={closed} onImported={vi.fn()} returnFocus={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Session file"), { target: { files: [new File(["fixture"], "run.jsonl")] } });
    fireEvent.click(screen.getByRole("button", { name: "Import and open" }));
    expect(screen.getByRole("button", { name: "Close import" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closed).not.toHaveBeenCalled();
    act(() => report?.(50));
    expect(screen.getByRole("status").textContent).toContain("Uploading 50%");
    act(() => report?.(100));
    expect(screen.getByRole("status").textContent).toContain("Validating records");
    await act(async () => finish?.(Imported));
  });

  it("rejects unsupported files and reports server failures without closing", async () => {
    const closed = vi.fn();
    const imported = vi.fn();
    const upload = vi.spyOn(api, "importSessionFile").mockRejectedValue(new Error("Line 7 contains invalid JSON."));
    render(<SessionImportDialog open onClose={closed} onImported={imported} returnFocus={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Session file"), { target: { files: [new File(["fixture"], "run.csv")] } });
    expect(screen.getByRole("alert").textContent).toContain("Choose");
    expect(screen.getByRole("button", { name: "Import and open" }).hasAttribute("disabled")).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    fireEvent.drop(screen.getByRole("button", { name: /Drop a file/ }), { dataTransfer: { files: [new File(["fixture"], "run.ndjson")] } });
    fireEvent.click(screen.getByRole("button", { name: "Import and open" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Line 7"));
    expect(closed).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import and open" }).hasAttribute("disabled")).toBe(false);
  });
});
