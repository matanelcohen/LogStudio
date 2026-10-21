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
  describe("listen-all application selection", () => {
    const application = { processId: 42, name: "Example.Api", startedAtTicks: "639112345678901234" };
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
    afterEach(() => {
      vi.mocked(useLogPage).mockReturnValue({ page: fixturePage(), loading: false, error: null, refresh: vi.fn() });
    });

    it("shows one compact error row before the next log and keeps its full text in the inspector", () => {
      renderRows();
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

    it("only displays message line breaks when wrapping is explicitly enabled", async () => {
      renderRows();
      expect(screen.getByText("+4 lines")).toBeDefined();
      fireEvent.keyDown(screen.getByRole("button", { name: "Explorer options" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Wrap long lines" }));
      const preview = screen.getByText(/fail: App.Skill/, { selector: "pre" });
      expect(getComputedStyle(preview).whiteSpace).toBe("pre-wrap");
      expect(preview.textContent).toBe(error.message);
      expect(screen.queryByText("+4 lines")).toBeNull();

      fireEvent.keyDown(screen.getByRole("button", { name: "Explorer options" }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Wrap long lines" }));
      expect(getComputedStyle(screen.getByText(/fail: App.Skill/, { selector: "pre" })).whiteSpace).toBe("nowrap");
      expect(screen.getByText("+4 lines")).toBeDefined();
    });

    it.each([
      ["a single line", "One message", 0],
      ["an empty message", "", 0],
      ["LF", "First\nSecond", 1],
      ["CRLF", "First\r\nSecond\r\nThird", 2],
      ["CR", "First\rSecond", 1],
      ["mixed line endings", "First\r\nSecond\nThird\rFourth", 3]
    ])("counts additional lines for %s without changing the original text", (_, message, extraLines) => {
      renderRows([{ ...Entry, message }]);
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

    it("updates the multiline hint when a live entry receives additional stack frames", () => {
      const { rerender } = renderRows();
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
