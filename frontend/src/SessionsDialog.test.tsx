import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionsDialog } from "./SessionsDialog";
import type { SessionInfo } from "./model";
import { comparisonGroup, comparisonSessions, comparisonSnapshot } from "./comparison-test-fixtures";

const Sessions: SessionInfo[] = [
  { id: "current", name: "Current run", startedAt: "2026-10-12T08:00:00Z", completedAt: null, exitCode: null, entryCount: 10, command: "dotnet", arguments: ["run"], workingDirectory: "/current", isCurrent: true },
  { id: "saved", name: "Named prior skill", startedAt: "2026-10-11T08:00:00Z", completedAt: "2026-10-11T08:01:00Z", exitCode: 0, entryCount: 1000, command: "dotnet", arguments: ["run", "--skill-name=Investigate"], workingDirectory: "/saved", isCurrent: false }
];

describe("session browser", () => {
  it("finds prior sessions by arguments and opens their run details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(Sessions))));
    const select = vi.fn();
    render(<SessionsDialog open selected="" onClose={vi.fn()} onSelect={select} returnFocus={vi.fn()} />);
    await screen.findByText("Named prior skill");
    fireEvent.change(screen.getByLabelText("Find sessions"), { target: { value: "Investigate" } });
    expect(screen.queryByText("Current run")).toBeNull();
    fireEvent.click(screen.getByText("Run parameters"));
    expect(screen.getByText("--skill-name=Investigate", { exact: false }).textContent).toContain("Investigate");
    fireEvent.click(screen.getByText("View session"));
    expect(select).toHaveBeenCalledWith(Sessions[1]);
  });

  it("shows catalog failures instead of a success-shaped empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Saved metadata unreadable" }), { status: 500 })));
    render(<SessionsDialog open selected="" onClose={vi.fn()} onSelect={vi.fn()} returnFocus={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Saved metadata unreadable"));
  });

  it("exports any session and renames saved sessions with a validated name", async () => {
    const renamed = { ...Sessions[1], name: "Renamed investigation" };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(Sessions)))
      .mockResolvedValueOnce(new Response(JSON.stringify(renamed)))
      .mockResolvedValueOnce(new Response(JSON.stringify([Sessions[0], renamed])));
    vi.stubGlobal("fetch", fetcher);
    render(<SessionsDialog open selected="" onClose={vi.fn()} onSelect={vi.fn()} returnFocus={vi.fn()} />);
    await screen.findByText("Named prior skill");
    expect(screen.getByLabelText("Rename Current run").hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("Delete Current run").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Export Current run").getAttribute("href")).toBe("api/export-session");
    expect(screen.getByLabelText("Export Named prior skill").getAttribute("href")).toBe("api/export-session?sessionId=saved");
    fireEvent.click(screen.getByLabelText("Rename Named prior skill"));
    fireEvent.change(screen.getByLabelText("New session name"), { target: { value: " " } });
    expect(screen.getByRole("button", { name: "Save name" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("New session name"), { target: { value: renamed.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await screen.findByText(renamed.name);
    expect(fetcher).toHaveBeenNthCalledWith(2, "api/sessions?sessionId=saved",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Log-Studio-Action": "rename" }) }));
  });

  it("renames the current session and notifies the explorer with its unchanged identity", async () => {
    const renamed = { ...Sessions[0], name: "Current investigation" };
    const onRenamed = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(Sessions)))
      .mockResolvedValueOnce(new Response(JSON.stringify(renamed)))
      .mockResolvedValueOnce(new Response(JSON.stringify([renamed, Sessions[1]])));
    vi.stubGlobal("fetch", fetcher);
    render(<SessionsDialog open selected="" onClose={vi.fn()} onSelect={vi.fn()} onRenamed={onRenamed} returnFocus={vi.fn()} />);
    await screen.findByText("Named prior skill");
    fireEvent.click(screen.getByLabelText("Rename Current run"));
    expect((screen.getByLabelText("New session name") as HTMLInputElement).value).toBe("Current run");
    fireEvent.change(screen.getByLabelText("New session name"), { target: { value: renamed.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await screen.findByRole("button", { name: "Rename Current investigation" });
    expect(onRenamed).toHaveBeenCalledWith(renamed);
    expect(fetcher).toHaveBeenNthCalledWith(2, "api/sessions?sessionId=current",
      expect.objectContaining({ body: JSON.stringify({ name: renamed.name }) }));
    expect(screen.getByLabelText("Delete Current investigation").hasAttribute("disabled")).toBe(true);
  });

  it("requires confirmation before deleting and notifies the viewed-session owner", async () => {
    const deleted = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(Sessions)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify([Sessions[0]])));
    vi.stubGlobal("fetch", fetcher);
    render(<SessionsDialog open selected="saved" onClose={vi.fn()} onSelect={vi.fn()} onDeleted={deleted} returnFocus={vi.fn()} />);
    await screen.findByText("Named prior skill");
    fireEvent.click(screen.getByLabelText("Delete Named prior skill"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Permanently remove/).textContent).toContain("Named prior skill");
    fireEvent.click(screen.getByRole("button", { name: "Delete saved session" }));
    await waitFor(() => expect(deleted).toHaveBeenCalledWith("saved"));
    await waitFor(() => expect(screen.queryByText("Named prior skill")).toBeNull());
  });

  it("keeps failed management actions visible and opens the import dialog", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(Sessions)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Disk permission denied" }), { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    render(<SessionsDialog open selected="" onClose={vi.fn()} onSelect={vi.fn()} returnFocus={vi.fn()} />);
    await screen.findByText("Named prior skill");
    fireEvent.click(screen.getByLabelText("Delete Named prior skill"));
    fireEvent.click(screen.getByRole("button", { name: "Delete saved session" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Disk permission denied"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("heading", { name: "Import a session" })).toBeDefined();
  });

  it("compares without selecting a session and returns from evidence to the existing result view", async () => {
    const select = vi.fn();
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "api/sessions") return new Response(JSON.stringify(comparisonSessions));
      if (url.includes("/groups?")) return new Response(JSON.stringify({ groups: [comparisonGroup()], total: 1, offset: 0, pageSize: 50 }));
      if (url.includes("/evidence?")) return new Response(JSON.stringify({ sessionId: "baseline", entries: [
        { id: 1, timestamp: "2026-10-11T08:00:01Z", severity: "error", category: "Worker", stream: "stderr", message: "Unchanged explorer evidence", isPartial: false }
      ], nextAfter: null }));
      return new Response(JSON.stringify(comparisonSnapshot({ state: init?.headers && "X-Log-Studio-Action" in init.headers &&
        init.headers["X-Log-Studio-Action"] === "cancel-comparison" ? "cancelled" : "completed" })));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SessionsDialog open selected="baseline" onClose={vi.fn()} onSelect={select} returnFocus={vi.fn()} />);
    await screen.findByText("Before run");
    fireEvent.click(screen.getByRole("button", { name: "Compare saved runs" }));
    for (const [label, name] of [["Baseline session", /Before run/], ["Candidate session", /After run/]] as const) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" });
    }
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    fireEvent.click(await screen.findByRole("button", { name: "View baseline evidence for Request <number> failed" }));
    await screen.findByText("Unchanged explorer evidence");
    fireEvent.click(screen.getByRole("button", { name: "Back to comparison results" }));
    expect(screen.getByRole("cell", { name: "+3" })).toBeDefined();
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("api/comparison?id=comparison%2Fone", expect.objectContaining({
      method: "POST", headers: { "X-Log-Studio-Action": "cancel-comparison" }
    })));
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeDefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("releases the running comparison when its parent closes and also releases late creation on unmount", async () => {
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { complete = resolve; });
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "api/sessions") return new Response(JSON.stringify(comparisonSessions));
      if (url === "api/comparison" && init?.method === "POST") return pending;
      return new Response(JSON.stringify(comparisonSnapshot({ state: "cancelled" })));
    });
    vi.stubGlobal("fetch", fetcher);
    const props = { open: true, selected: "", onClose: vi.fn(), onSelect: vi.fn(), returnFocus: vi.fn() };
    const { rerender } = render(<SessionsDialog {...props} />);
    await screen.findByText("Before run");
    fireEvent.click(screen.getByRole("button", { name: "Compare saved runs" }));
    for (const [label, name] of [["Baseline session", /Before run/], ["Candidate session", /After run/]] as const) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" });
    }
    fireEvent.click(screen.getByRole("button", { name: "Compare runs" }));
    expect(screen.getByText("Starting comparison…")).toBeDefined();
    rerender(<SessionsDialog {...props} open={false} />);
    complete(new Response(JSON.stringify(comparisonSnapshot({ state: "running", phase: "candidate", processedEntries: 100 }))));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("api/comparison?id=comparison%2Fone", expect.objectContaining({
      method: "POST", headers: { "X-Log-Studio-Action": "cancel-comparison" }
    })));
    expect(screen.queryByRole("region", { name: "Comparison results" })).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
