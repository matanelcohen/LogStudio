import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { Entry, fixturePage, Status } from "./test-fixtures";
import { useLiveStatus, useLogPage } from "./useLogExplorer";
import { DefaultTypography, TypographyStorageKey } from "./useTypography";
import * as api from "./api";
import { defaultQuery, sessionFilters, type ChatResponse, type LogEntry, type RunningApplicationsState } from "./model";

const reconnect = vi.hoisted(() => vi.fn());
const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

beforeEach(() => {
  localStorage.removeItem(TypographyStorageKey);
  sessionStorage.clear();
  vi.spyOn(api, "fetchSessions").mockResolvedValue([]);
  vi.spyOn(api, "saveSessionFilters").mockResolvedValue();
  vi.spyOn(api, "fetchCopilotHistory").mockResolvedValue([]);
});
afterEach(() => localStorage.removeItem(TypographyStorageKey));

vi.mock("./useLogExplorer", async () => {
  const { Status, fixturePage } = await import("./test-fixtures");
  return {
    useLiveStatus: vi.fn(() => ({
      status: Status, connection: "live", error: null, gap: null,
      reconnect, applyStatus: vi.fn()
    })),
    useLogPage: vi.fn(() => ({ page: fixturePage(), loading: false, error: null, refresh: vi.fn() }))
  };
});

describe("log-first workspace", () => {
  describe("wrapped program input", () => {
    const running = { ...Status, isCompleted: false, completedAt: null, exitCode: null, canWriteInput: true };
    function liveStatus(status = running) {
      vi.mocked(useLiveStatus).mockReturnValue({
        status, connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
      });
    }
    afterEach(() => {
      vi.mocked(useLiveStatus).mockReturnValue({
        status: Status, connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
      });
    });

    it("preserves the input draft while searching and pausing, but hides it when live input closes", () => {
      liveStatus();
      const { rerender } = render(<App />);
      const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "answer draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "hello" } });
      expect(screen.getByLabelText("Terminal input")).toBe(input);
      expect(input.value).toBe("answer draft");
      liveStatus({ ...running, canWriteInput: false });
      rerender(<App />);
      expect(screen.queryByLabelText("Terminal input")).toBeNull();
    });

    it("does not expose input for completed runs or listen-all mode", () => {
      liveStatus({ ...running, isCompleted: true });
      const { rerender } = render(<App />);
      expect(screen.queryByLabelText("Terminal input")).toBeNull();
      vi.mocked(useLiveStatus).mockReturnValue({
        status: { ...running, listenAll: true }, connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
      });
      vi.spyOn(api, "fetchApplications").mockResolvedValue({ applications: [], selected: null, error: null });
      rerender(<App />);
      expect(screen.queryByLabelText("Terminal input")).toBeNull();
    });

    it("never sends input to a live program while browsing a saved session", async () => {
      liveStatus();
      vi.mocked(api.fetchSessions).mockResolvedValue([{
        id: "saved", name: "Saved run", startedAt: Status.startedAt, completedAt: Status.completedAt,
        exitCode: 0, entryCount: 1, command: "dotnet", arguments: [], workingDirectory: "", isCurrent: false
      }]);
      render(<App />);
      expect(screen.getByLabelText("Terminal input")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
      fireEvent.click(await screen.findByRole("button", { name: "View session" }));
      expect(screen.queryByLabelText("Terminal input")).toBeNull();
    });
  });

  describe("listen-all application selection", () => {
    const application = { processId: 42, name: "Example.Api", startedAtTicks: "639112345678901234" };
    const worker = { processId: 43, name: "Example.Worker", startedAtTicks: "639112345678901235", path: "/repo/Example.Worker.dll" };
    const group = {
      ...application, groupId: "launch:42:639112345678901234", path: "/repo/Example.Api.dll",
      processes: [{ ...application, path: "/repo/Example.Api.dll" }, worker]
    };
    const waiting: RunningApplicationsState = { applications: [application], selected: null, error: null };
    beforeEach(() => {
      vi.mocked(useLiveStatus).mockReturnValue({
        status: { ...Status, listenAll: true, isCompleted: false, completedAt: null, exitCode: null }, connection: "live", error: null, gap: null,
        reconnect, applyStatus: vi.fn()
      });
      vi.spyOn(api, "fetchApplications").mockResolvedValue(waiting);
    });
    afterEach(() => {
      vi.mocked(useLiveStatus).mockReturnValue({
        status: Status, connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
      });
    });

    it("waits for explicit selection even when only one app is running, including refresh", async () => {
      const select = vi.spyOn(api, "selectApplication");
      render(<App />);
      const dropdown = await screen.findByRole("combobox", { name: "Running app" }) as HTMLSelectElement;
      await screen.findByRole("option", { name: "Example.Api (PID 42)" });
      expect(dropdown.value).toBe("");
      expect(screen.getByText("Choose an app")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Refresh apps" }));
      await waitFor(() => expect(api.fetchApplications).toHaveBeenCalledTimes(2));
      expect(dropdown.value).toBe("");
      expect(select).not.toHaveBeenCalled();
    });

    it("shows one app choice with its path and PIDs and searches app names, paths, and member PIDs", async () => {
      const other = { ...group, processId: 50, groupId: "other", path: "/another/Example.Api.dll", processes: [{ ...application, processId: 50 }] };
      const tooling = { ...application, processId: 60, name: "MSBuild", isTool: true };
      vi.mocked(api.fetchApplications).mockResolvedValue({ ...waiting, applications: [group, other, tooling] });
      const select = vi.spyOn(api, "selectApplication");
      render(<App />);
      await screen.findByRole("option", { name: /2 processes; PIDs 42, 43.*\/repo\/Example.Api.dll/ });
      expect(screen.getByRole("group", { name: ".NET tooling" }).textContent).toContain("MSBuild");
      for (const term of ["EXAMPLE.WORKER", "/REPO/", "43"]) {
        fireEvent.change(screen.getByRole("searchbox", { name: "Find running app" }), { target: { value: term } });
        expect(screen.getAllByRole("option")).toHaveLength(2);
        expect(screen.getByRole("option", { name: /PIDs 42, 43/ })).toBeDefined();
      }
      fireEvent.change(screen.getByRole("searchbox", { name: "Find running app" }), { target: { value: "not-a-running-app" } });
      expect(screen.getByRole("option", { name: "No apps match your search" })).toBeDefined();
      expect(select).not.toHaveBeenCalled();
    });

    it("selects the entire app and exposes the captured process paths", async () => {
      const grouped = { ...waiting, applications: [group] };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce(grouped).mockResolvedValue({ ...grouped, selected: group });
      vi.spyOn(api, "selectApplication").mockResolvedValue({ ...grouped, selected: group });
      render(<App />);
      await screen.findByRole("option", { name: /PIDs 42, 43/ });
      fireEvent.change(screen.getByRole("combobox", { name: "Running app" }), { target: { value: group.groupId } });
      await screen.findByText("Listening to Example.Api · 2 processes");
      expect(api.selectApplication).toHaveBeenCalledExactlyOnceWith(group);
      expect(screen.getByText("PID 43")).toBeDefined();
      expect(screen.getByText("/repo/Example.Worker.dll")).toBeDefined();
    });

    it("keeps the selected group and a paused investigation when the lead PID changes", async () => {
      const updated = { ...group, processId: worker.processId, startedAtTicks: worker.startedAtTicks, processes: [worker] };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ ...waiting, applications: [group], selected: group })
        .mockResolvedValue({ ...waiting, applications: [updated], selected: updated });
      const select = vi.spyOn(api, "selectApplication");
      render(<App />);
      await screen.findByText("Listening to Example.Api · 2 processes");
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Find running app" }), { target: { value: "unrelated search" } });
      fireEvent.click(screen.getByRole("button", { name: "Refresh apps" }));
      await screen.findByText("Listening to Example.Api · 1 process");
      expect((screen.getByRole("combobox", { name: "Running app" }) as HTMLSelectElement).value).toBe(group.groupId);
      expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
      expect(select).not.toHaveBeenCalled();
      expect(screen.queryByText("PID 42")).toBeNull();
    });

    it("makes partial capture explicit while opening the successfully attached group", async () => {
      const partial = { ...waiting, applications: [group], selected: { ...group, processes: [worker] }, error: "Could not attach to PID 42." };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ ...waiting, applications: [group] }).mockResolvedValue(partial);
      vi.spyOn(api, "selectApplication").mockResolvedValue(partial);
      render(<App />);
      await screen.findByRole("option", { name: /PIDs 42, 43/ });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Running app" }), { target: { value: group.groupId } });
      await screen.findByText("Listening to Example.Api · 1 process");
      expect(screen.getByRole("alert").textContent).toContain("Could not attach to PID 42.");
      expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Retry app" })).toBeDefined();
    });

    it("clears a partial attachment warning when the missing process connects", async () => {
      const partial = { ...waiting, applications: [group], selected: { ...group, processes: [worker] }, error: "Could not attach to PID 42." };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ ...waiting, applications: [group] }).mockResolvedValue(partial);
      vi.spyOn(api, "selectApplication").mockResolvedValue(partial);
      render(<App />);
      await screen.findByRole("option", { name: /PIDs 42, 43/ });
      fireEvent.change(screen.getByRole("combobox", { name: "Running app" }), { target: { value: group.groupId } });
      await screen.findByRole("button", { name: "Retry app" });
      vi.mocked(api.fetchApplications).mockResolvedValue({ ...waiting, applications: [group], selected: group });
      fireEvent.click(screen.getByRole("button", { name: "Refresh apps" }));
      await screen.findByText("Listening to Example.Api · 2 processes");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry app" })).toBeNull();
    });

    it("retries missing processes without resetting a paused investigation", async () => {
      const partial = { ...waiting, applications: [group], selected: { ...group, processes: [worker] }, error: "Could not attach to PID 42." };
      const connected = { ...waiting, applications: [group], selected: group };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce(partial).mockResolvedValue(connected);
      vi.spyOn(api, "selectApplication").mockResolvedValue(connected);
      render(<App />);
      await screen.findByRole("button", { name: "Retry app" });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Keep my query" } });
      fireEvent.click(screen.getByRole("button", { name: "Retry app" }));
      await screen.findByText("Listening to Example.Api · 2 processes");
      expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
      expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("Keep my query");
      expect(api.selectApplication).toHaveBeenCalledExactlyOnceWith(group);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows connecting rather than listening while a replacement process attaches", async () => {
      vi.mocked(api.fetchApplications).mockResolvedValue({ ...waiting, applications: [group], selected: { ...group, processes: [] } });
      render(<App />);
      await screen.findByText("Connecting to Example.Api…");
      expect(screen.queryByText("Listening to Example.Api · 0 processes")).toBeNull();
    });

    it("attaches only the chosen process and resumes the live view", async () => {
      vi.spyOn(api, "selectApplication").mockResolvedValue({ ...waiting, selected: application });
      vi.mocked(api.fetchApplications).mockResolvedValueOnce(waiting).mockResolvedValue({ ...waiting, selected: application });
      render(<App />);
      await screen.findByRole("option", { name: "Example.Api (PID 42)" });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Running app" }), {
        target: { value: `${application.processId}:${application.startedAtTicks}` }
      });
      await screen.findByText("Listening to Example.Api");
      expect(api.selectApplication).toHaveBeenCalledExactlyOnceWith(application);
      expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
      expect(reconnect).toHaveBeenCalled();
    });

    it("keeps a failed selection visible after refreshing discovery", async () => {
      vi.spyOn(api, "selectApplication").mockRejectedValue(new Error("The application exited."));
      render(<App />);
      await screen.findByRole("option", { name: "Example.Api (PID 42)" });
      fireEvent.change(screen.getByRole("combobox", { name: "Running app" }), {
        target: { value: `${application.processId}:${application.startedAtTicks}` }
      });
      await waitFor(() => expect(api.fetchApplications).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("alert").textContent).toContain("The application exited.");
      expect((screen.getByRole("combobox", { name: "Running app" }) as HTMLSelectElement).value).toBe("");
    });

    it("shows empty discovery without attaching", async () => {
      vi.mocked(api.fetchApplications).mockResolvedValue({ ...waiting, applications: [] });
      const select = vi.spyOn(api, "selectApplication");
      render(<App />);
      await screen.findByRole("option", { name: "No running .NET apps found" });
      expect(screen.getByText("Waiting for you to choose an app.")).toBeDefined();
      expect(select).not.toHaveBeenCalled();
    });

    it("shows an existing selection on reload but does not attach a replacement when it exits", async () => {
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ ...waiting, selected: application }).mockResolvedValue(waiting);
      const select = vi.spyOn(api, "selectApplication");
      render(<App />);
      await screen.findByText("Listening to Example.Api");
      fireEvent.click(screen.getByRole("button", { name: "Refresh apps" }));
      await screen.findByText("Waiting for you to choose an app.");
      expect((screen.getByRole("combobox", { name: "Running app" }) as HTMLSelectElement).value).toBe("");
      expect(select).not.toHaveBeenCalled();
    });

    it("does not reset a paused investigation when the collector reports an attachment error", async () => {
      vi.spyOn(api, "selectApplication").mockResolvedValue({ ...waiting, error: "Attaching timed out." });
      render(<App />);
      await screen.findByRole("option", { name: "Example.Api (PID 42)" });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Keep my query" } });
      fireEvent.change(screen.getByRole("combobox", { name: "Running app" }), {
        target: { value: `${application.processId}:${application.startedAtTicks}` }
      });
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Attaching timed out."));
      expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
      expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("Keep my query");
    });
  });

  it("preserves Copilot conversation and drafts while searching logs", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue({ version: "test CLI", models: [] });
    vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Existing answer", contextEntryCount: 1, contextTruncated: false });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    const panel = screen.getByRole("complementary", { name: "Ask Copilot about logs" });
    await screen.findByRole("combobox", { name: "AI model" });
    const input = screen.getByLabelText("Message Copilot") as HTMLTextAreaElement;
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
    fireEvent.change(input, { target: { value: "First question" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Send message" }));
    await screen.findByText("Existing answer");
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover logs" }));
    expect(panel.isConnected).toBe(true);
    expect(screen.getByRole("complementary", { name: "Ask Copilot about logs" })).toBe(panel);
    expect(panel.hidden).toBe(false);
    expect(input.value).toBe("Keep this draft");
    expect(screen.getByRole("log").textContent).toContain("First question");
    expect(screen.getByRole("log").textContent).toContain("Existing answer");
  });

  it("returns to the Ask Copilot opener when closing an expanded chat", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue({ version: "test CLI", models: [] });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    await screen.findByRole("combobox", { name: "AI model" });
    fireEvent.click(screen.getByRole("button", { name: "Expand Copilot chat" }));
    expect(screen.getByRole("dialog", { name: "Ask Copilot about logs" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close Copilot chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Ask Copilot about logs" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Ask Copilot" })));
  });

  it("retains an in-flight Copilot response while inspecting a log", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue({ version: "test CLI", models: [] });
    let finish!: (value: ChatResponse) => void;
    const ask = vi.spyOn(api, "askCopilot").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    const panel = screen.getByRole("complementary", { name: "Ask Copilot about logs" });
    await screen.findByRole("combobox", { name: "AI model" });
    const input = screen.getByLabelText("Message Copilot");
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
    fireEvent.change(input, { target: { value: "In-flight question" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Send message" }));
    fireEvent.click(screen.getByRole("row", { name: /Hello/ }));
    expect(screen.getByRole("button", { name: "Toggle inspector" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => finish({ answer: "Response while inspecting", contextEntryCount: 1, contextTruncated: false }));
    expect(screen.getByText("Response while inspecting")).toBeDefined();
    expect(screen.getByRole("log").textContent).toContain("In-flight question");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close Copilot chat" }).hasAttribute("disabled")).toBe(false);
  });

  it("exposes only logs and sessions without requesting telemetry", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    const navigation = screen.getByRole("navigation", { name: "Workspace applications" });
    expect(within(navigation).getAllByRole("button").map(button => button.getAttribute("aria-label")))
      .toEqual(["Discover logs", "Browse sessions"]);
    expect(screen.queryByRole("button", { name: "Metrics" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Traces" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure sources" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover logs" }));
    expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("Hello");
    expect(document.activeElement).toBe(screen.getByLabelText("Search logs"));
    expect(screen.getByRole("main", { name: "Log exploration workspace" })).toBeDefined();
    expect(screen.queryByRole("searchbox", { name: "Search metrics" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search traces" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the summary, field browser, timeline, and empty inspector out of the default layout", () => {
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Log Studio" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Discover" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Discover logs" }).getAttribute("aria-current")).toBe("page");
    const workspace = screen.getByRole("main", { name: "Log exploration workspace" });
    expect(screen.getByRole("link", { name: "Skip to log results" }).getAttribute("href")).toBe(`#${workspace.id}`);
    expect(workspace.tabIndex).toBe(-1);
    expect(container.querySelector(".summary")).toBeNull();
    expect(container.querySelector(".discover-fields")).toBeNull();
    expect(container.querySelector(".page-chart")).toBeNull();
    expect(container.querySelector(".details-panel")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /Stream/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeDefined();
    expect(screen.getByLabelText("Search logs")).toBeDefined();
  });

  it("opens the optional panels explicitly and opens the inspector by selecting a row", () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Available fields" }));
    expect(screen.getByRole("complementary", { name: "Discover fields" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Toggle timeline" }));
    expect(container.querySelector(".page-chart")).not.toBeNull();
    fireEvent.click(screen.getByRole("row", { name: /Hello/ }));
    expect(container.querySelector(".details-panel")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Toggle inspector" }).getAttribute("aria-pressed")).toBe("true");
  });

  describe("multiline log rows", () => {
    const error: LogEntry = {
      ...Entry, severity: "error",
      message: "fail: App.Skill[0]\n      Request failed: AgentId is not set\n" +
        "      System.InvalidOperationException: AgentId is not set\n" +
        "         at Example.Run()\n         at Example.Main()"
    };
    const next: LogEntry = { ...Entry, id: 2, message: "Next log event" };

    function renderRows(entries: LogEntry[] = [error, next]) {
      vi.mocked(useLogPage).mockReturnValue({
        page: {
          ...fixturePage(error), entries, matchCount: entries.length, highlightTerms: ["AgentId"],
          errorCount: entries.filter(entry => entry.severity === "error" || entry.severity === "critical").length,
          warningCount: entries.filter(entry => entry.severity === "warning").length
        },
        loading: false, error: null, refresh: vi.fn()
      });
      return render(<><style>{styles}</style><App /></>);
    }
    async function toggleWrap() {
      fireEvent.keyDown(screen.getByRole("button", { name: "Explorer options" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Wrap long lines" }));
    }
    afterEach(() => {
      vi.mocked(useLogPage).mockReturnValue({ page: fixturePage(), loading: false, error: null, refresh: vi.fn() });
    });

    it("shows a compact error row when wrapping is disabled and keeps its full text in the inspector", async () => {
      renderRows();
      await toggleWrap();
      const table = screen.getByRole("table", { name: "Captured logs" });
      const rows = table.querySelectorAll("tbody tr");
      expect(rows).toHaveLength(2);
      const row = screen.getByRole("row", { name: /Request failed/ });
      const preview = within(row).getByText(/fail: App.Skill/, { selector: "pre" });
      expect(getComputedStyle(preview).whiteSpace).toBe("nowrap");
      expect(preview.textContent).toBe(error.message);
      expect(within(row).getAllByText("AgentId", { selector: "mark" })).toHaveLength(2);
      expect(rows[1]?.textContent).toContain(next.message);
      const hint = within(row).getByText("+4 lines");
      expect(hint.parentElement?.title).toBe("4 additional lines. Select this row to inspect the full message.");
      expect(within(row).getByText("4 additional lines. Select this row to inspect the full message.").className).toBe("visually-hidden");
      expect(rows[1]?.querySelector(".message-lines")).toBeNull();

      fireEvent.click(hint);
      const inspector = screen.getByRole("complementary", { name: "Entry inspector" });
      const details = within(inspector).getByText(/fail: App.Skill/, { selector: "pre" });
      expect(details.textContent).toBe(error.message);
      expect(getComputedStyle(details).whiteSpace).toBe("pre-wrap");
    });

    it("wraps messages by default and lets users disable and re-enable wrapping", async () => {
      renderRows();
      const preview = screen.getByText(/fail: App.Skill/, { selector: "pre" });
      expect(getComputedStyle(preview).whiteSpace).toBe("pre-wrap");
      expect(preview.textContent).toBe(error.message);
      expect(screen.queryByText("+4 lines")).toBeNull();
      const rows = screen.getByRole("table", { name: "Captured logs" }).querySelectorAll("tbody tr");
      expect(rows).toHaveLength(2);
      expect(rows[1]?.textContent).toContain(next.message);

      fireEvent.keyDown(screen.getByRole("button", { name: "Explorer options" }), { key: "Enter" });
      const wrapOption = await screen.findByRole("menuitemcheckbox", { name: "Wrap long lines" });
      expect(wrapOption.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(wrapOption);
      expect(getComputedStyle(screen.getByText(/fail: App.Skill/, { selector: "pre" })).whiteSpace).toBe("nowrap");
      expect(screen.getByText("+4 lines")).toBeDefined();

      await toggleWrap();
      const wrappedPreview = screen.getByText(/fail: App.Skill/, { selector: "pre" });
      expect(getComputedStyle(wrappedPreview).whiteSpace).toBe("pre-wrap");
      expect(wrappedPreview.textContent).toBe(error.message);
      expect(screen.queryByText("+4 lines")).toBeNull();
    });

    it.each([
      ["a single line", "One message", 0],
      ["an empty message", "", 0],
      ["LF", "First\nSecond", 1],
      ["CRLF", "First\r\nSecond\r\nThird", 2],
      ["CR", "First\rSecond", 1],
      ["mixed line endings", "First\r\nSecond\nThird\rFourth", 3]
    ])("counts additional lines for %s without changing the original text", async (_, message, extraLines) => {
      renderRows([{ ...Entry, message }]);
      await toggleWrap();
      const row = screen.getByRole("table", { name: "Captured logs" }).querySelector("tbody tr");
      expect(row?.querySelector("pre")?.textContent).toBe(message);
      if (extraLines === 0) {
        expect(row?.querySelector(".message-lines")).toBeNull();
      } else {
        expect(screen.getByText(`+${extraLines} ${extraLines === 1 ? "line" : "lines"}`)).toBeDefined();
      }
    });

    it("keeps severity cues on rows when selecting entries or hiding the level column", async () => {
      const entries: LogEntry[] = [
        { ...Entry, id: 1, severity: "information", message: "Informational entry" },
        { ...Entry, id: 2, severity: "warning", message: "Warning entry" },
        { ...Entry, id: 3, severity: "error", message: "Error entry" },
        { ...Entry, id: 4, severity: "critical", message: "Critical entry" }
      ];
      renderRows(entries);
      const table = screen.getByRole("table", { name: "Captured logs" });
      const rows = table.querySelectorAll("tbody tr");
      expect([...rows].map(row => row.getAttribute("data-severity"))).toEqual(entries.map(entry => entry.severity));
      expect([...table.querySelectorAll(".severity-badge")].map(badge => badge.textContent)).toEqual(["Info", "Warn", "Error", "Critical"]);

      fireEvent.keyDown(screen.getByRole("row", { name: /Error entry/ }), { key: "Enter" });
      expect(rows[2]?.classList.contains("selected")).toBe(true);
      fireEvent.keyDown(screen.getByRole("row", { name: /Warning entry/ }), { key: " " });
      expect(rows[1]?.classList.contains("selected")).toBe(true);
      expect(rows[2]?.classList.contains("selected")).toBe(false);

      fireEvent.keyDown(screen.getByRole("button", { name: "Columns" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Level" }));
      expect(screen.queryByRole("columnheader", { name: /Level/ })).toBeNull();
      expect(table.querySelector(".severity-badge")).toBeNull();
      expect([...rows].map(row => row.getAttribute("data-severity"))).toEqual(entries.map(entry => entry.severity));
    });

    it("updates the multiline hint when a live entry receives additional stack frames", async () => {
      const { rerender } = renderRows();
      await toggleWrap();
      const updated = { ...error, message: `${error.message}\n         at Example.Finish()` };
      vi.mocked(useLogPage).mockReturnValue({
        page: { ...fixturePage(updated), entries: [updated, next], matchCount: 2, errorCount: 1, highlightTerms: ["AgentId"] },
        loading: false, error: null, refresh: vi.fn()
      });
      rerender(<><style>{styles}</style><App /></>);
      expect(screen.queryByText("+4 lines")).toBeNull();
      expect(screen.getByText("+5 lines")).toBeDefined();
      expect(screen.getByText(/fail: App.Skill/, { selector: "pre" }).textContent).toBe(updated.message);
      expect(screen.getByRole("table", { name: "Captured logs" }).querySelectorAll("tbody tr")).toHaveLength(2);
    });
  });

  it("turns inline severity counts into real filters and makes import directly available", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Filter error entries" }));
    expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[0].levels).toEqual(["error", "critical"]);
    fireEvent.click(screen.getByRole("button", { name: "Filter warning entries" }));
    expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[0].levels).toEqual(["warning"]);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("heading", { name: "Import a session" })).toBeDefined();
  });

  it("opens Copilot in a non-modal panel before the log results, even with no visible matches", () => {
    vi.mocked(useLogPage).mockReturnValueOnce({ page: { ...fixturePage(), entries: [] }, loading: false, error: null, refresh: vi.fn() });
    render(<App />);
    expect(screen.queryByRole("heading", { name: "Ask Copilot about logs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    expect(screen.getByRole("heading", { name: "Ask Copilot about logs" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Connect local Copilot" })).toBeNull();
    const panel = screen.getByRole("complementary", { name: "Ask Copilot about logs" });
    expect(panel.parentElement).toBe(screen.getByRole("main", { name: "Log exploration workspace" }));
    expect(panel.nextElementSibling?.className).toBe("workspace");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Search logs").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close Copilot chat" }));
    expect(screen.queryByRole("complementary", { name: "Ask Copilot about logs" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Ask Copilot" }));
  });

  it("allows saved conversations to be reopened when a session has no remaining logs", async () => {
    const emptyStatus = { ...Status, retainedCount: 0, firstId: 0, lastId: 0 };
    vi.mocked(useLogPage).mockReturnValueOnce({
      page: { ...fixturePage(), status: emptyStatus, entries: [] }, loading: false, error: null, refresh: vi.fn()
    });
    vi.mocked(useLiveStatus).mockReturnValueOnce({
      status: emptyStatus, connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
    });
    vi.mocked(api.fetchCopilotHistory).mockResolvedValue([
      { role: "user", content: "Historical question" }, { role: "assistant", content: "Historical answer" }
    ]);
    vi.spyOn(api, "connectCopilot").mockRejectedValue(new Error("CLI unavailable"));
    render(<App />);
    const opener = screen.getByRole("button", { name: "Ask Copilot" });
    expect(opener.hasAttribute("disabled")).toBe(false);
    fireEvent.click(opener);
    await screen.findByText("Historical answer");
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
  });

  it("updates the session name while paused without resetting the frozen log cursor", async () => {
    const current = {
      id: "current", name: "Current run", startedAt: "2026-10-12T08:00:00Z",
      completedAt: null, exitCode: null, entryCount: 10, command: "dotnet",
      arguments: [], workingDirectory: "/current", isCurrent: true
    };
    const renamed = { ...current, name: "Paused investigation" };
    vi.mocked(api.fetchSessions).mockResolvedValue([current]);
    vi.spyOn(api, "renameSession").mockImplementation(async () => {
      vi.mocked(api.fetchSessions).mockResolvedValue([renamed]);
      return renamed;
    });
    const { container, rerender } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const maximumId = vi.mocked(useLogPage).mock.calls.at(-1)?.[2];
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    await screen.findByRole("button", { name: "Rename Current run" });
    fireEvent.click(screen.getByLabelText("Rename Current run"));
    fireEvent.change(screen.getByLabelText("New session name"), { target: { value: renamed.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(reconnect).toHaveBeenCalled());
    vi.mocked(useLiveStatus).mockReturnValueOnce({
      status: { ...Status, applicationName: "Newest live name", lastId: Status.lastId + 1, revision: Status.revision + 2 },
      connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
    });
    rerender(<App />);
    expect(container.querySelector("#applicationName")?.textContent).toBe("Newest live name");
    expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[2]).toBe(maximumId);
    fireEvent.click(screen.getByRole("button", { name: "Close sessions" }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
  });

  it("restores filters on reload and keeps current and saved sessions' filters separate", async () => {
    const current = {
      id: "current", name: "Current run", startedAt: "2026-10-12T08:00:00Z",
      completedAt: null, exitCode: null, entryCount: 10, command: null,
      arguments: [], workingDirectory: "", isCurrent: true,
      filters: sessionFilters({ ...defaultQuery(), search: "Current search", matchCase: true })
    };
    const saved = {
      ...current, id: "saved", name: "Saved run", isCurrent: false,
      filters: { ...current.filters, search: "Saved search", levels: [] }
    };
    vi.mocked(api.fetchSessions).mockResolvedValue([current, saved]);
    render(<App />);
    const search = screen.getByLabelText("Search logs") as HTMLInputElement;
    await waitFor(() => expect(search.value).toBe("Current search"));
    expect((screen.getByLabelText("Match case") as HTMLInputElement).checked).toBe(true);
    expect(api.saveSessionFilters).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: "Edited current" } });
    await waitFor(() => expect(api.saveSessionFilters).toHaveBeenCalledWith("", { ...current.filters, search: "Edited current" }));

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    fireEvent.click(await screen.findByRole("button", { name: "View session" }));
    expect(search.value).toBe("Saved search");
    expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[0]).toMatchObject({ sessionId: "saved", levels: [], dismissedThrough: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(api.saveSessionFilters).toHaveBeenCalledWith("saved", sessionFilters(defaultQuery())));
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    fireEvent.click(await screen.findByRole("button", { name: "View current" }));
    expect(search.value).toBe("Edited current");
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(api.saveSessionFilters).toHaveBeenLastCalledWith("", { ...current.filters, search: "" }));
  });

  it("keeps glass on chrome and provides opaque accessibility and unsupported-browser fallbacks", () => {
    const { container } = render(<><style>{styles}</style><App /></>);
    const rules = Array.from(container.querySelector("style")!.sheet!.cssRules);
    function declaration(rules: CSSRule[], selector: string, property: string) {
      return rules.filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE)
        .filter(rule => rule.selectorText.split(",").map(value => value.trim()).includes(selector))
        .map(rule => rule.style.getPropertyValue(property)).filter(Boolean).at(-1);
    }
    expect(declaration(rules, ".discover-shell", "background")).toBe("var(--cp-shell-material)");
    expect(declaration(rules, ".discover-shell", "border-radius")).toBe("20px");
    expect(declaration(rules, ".query-bar", "background")).toBe("var(--cp-card-material)");
    expect(declaration(rules, ".logs-scroll", "background")).toBe("var(--cp-content-material)");
    expect(declaration(rules, "tr[data-log-id]", "background")).toBe("var(--cp-surface)");

    const preferences = rules.find((rule): rule is CSSMediaRule =>
      rule.type === CSSRule.MEDIA_RULE && rule.cssText.includes("prefers-reduced-transparency"))!;
    expect(preferences.conditionText).toContain("prefers-contrast: more");
    const unsupported = rules.find((rule): rule is CSSSupportsRule =>
      rule.type === CSSRule.SUPPORTS_RULE && rule.cssText.includes("backdrop-filter"))!;
    for (const fallback of [preferences, unsupported]) {
      const fallbackRules = Array.from(fallback.cssRules);
      for (const theme of [":root", 'html[data-theme="dark"]']) {
        for (const material of ["shell", "chrome", "card", "content", "control"]) {
          expect(declaration(fallbackRules, theme, `--cp-${material}-material`)).toBe("var(--cp-surface)");
        }
        expect(declaration(fallbackRules, theme, "--cp-panel-strong")).toBe("var(--cp-surface)");
      }
    }
    expect(declaration(Array.from(preferences.cssRules), "body", "background-image")).toBe("none");
  });

  it("uses the chosen text sizes for controls, categories, badges, and inspector metadata", () => {
    const { container } = render(<><style>{styles}</style><App /></>);
    const rules = Array.from(container.querySelector("style")!.sheet!.cssRules)
      .filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    function fontSize(selector: string) {
      return rules.filter(rule => rule.selectorText.split(",").map(value => value.trim()).includes(selector))
        .map(rule => rule.style.getPropertyValue("font-size")).filter(Boolean).at(-1);
    }
    for (const selector of ["button", ".select-trigger", ".menu-item", ".tooltip", ".field-row", ".muted", ".copilot-copy", ".telemetry-status"]) {
      expect(fontSize(selector), selector).toBe("var(--ui-font-size, 14px)");
    }
    for (const selector of [".logs-scroll tbody", ".logs-scroll .severity-badge", ".message-lines", ".message", "#detailMessage", ".selected-details .metadata", ".selected-details .severity-badge"]) {
      expect(fontSize(selector), selector).toBe("var(--log-font-size, 14px)");
    }
    expect(fontSize(".category-cell")).toBeUndefined();
    expect(container.querySelector(".category-cell")?.closest("tbody")).not.toBeNull();
    expect(rules.find(rule => rule.selectorText === ".selected-details .metadata")?.style.getPropertyValue("grid-template-columns"))
      .toBe("minmax(0, 7em) minmax(0, 1fr)");
    expect(rules.find(rule => rule.selectorText === ".metadata dt")?.style.getPropertyValue("overflow-wrap")).toBe("anywhere");
  });

  it("changes typography immediately, keeps the current query, and restores focus on dismissal", async () => {
    render(<App />);
    const search = screen.getByLabelText("Search logs") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Hello" } });
    const opener = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "UI font" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Log font" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "UI font size" }).textContent).toContain("14 px");
    expect(screen.getByRole("combobox", { name: "Log font size" }).textContent).toContain("14 px");
    expect(screen.getByLabelText("Log font preview").textContent).toContain("Application started");

    async function choose(label: string, option: string) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
      fireEvent.keyDown(await screen.findByRole("option", { name: option }), { key: "Enter" });
    }

    const scroll = screen.getByLabelText("Scrollable log entries");
    Object.defineProperty(scroll, "scrollHeight", { value: 500, configurable: true });
    await choose("UI font", "Verdana");
    await choose("UI font size", "18 px");
    await choose("Log font", "Courier New");
    await choose("Log font size", "24 px");
    await choose("Log line spacing", "Spacious");
    expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("18px");
    expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("24px");
    expect(document.documentElement.style.getPropertyValue("--log-line-height")).toBe("2");
    expect(scroll.scrollTop).toBe(500);
    expect(JSON.parse(localStorage.getItem(TypographyStorageKey)!)).toEqual({
      uiFont: "verdana", uiFontSize: 18, logFont: "courier", logFontSize: 24, logLineHeight: 2
    });
    expect(search.value).toBe("Hello");
    expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[0].search).toBe("Hello");

    fireEvent.click(screen.getByRole("button", { name: "Reset typography" }));
    expect(JSON.parse(localStorage.getItem(TypographyStorageKey)!)).toEqual(DefaultTypography);
    expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("14px");
    expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("14px");
    expect(search.value).toBe("Hello");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("shows a storage warning without disabling settings", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage blocked"); });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText(/Browser storage is unavailable/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset typography" })).toBeDefined();
  });
});
