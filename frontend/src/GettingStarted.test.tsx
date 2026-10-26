import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { LogEmptyState } from "./GettingStarted";
import * as api from "./api";
import { defaultQuery, sessionFilters, type LogPage, type SessionInfo } from "./model";
import { DefaultPreferences, mergePreferences } from "./preferences";
import { sampleLogsFile, SampleSessionName } from "./sampleLogs";
import { Entry, fixturePage, Status } from "./test-fixtures";
import { useLiveStatus, useLogPage } from "./useLogExplorer";

vi.mock("./useLogExplorer", () => ({ useLiveStatus: vi.fn(), useLogPage: vi.fn() }));
const app = { processId: 42, startedAtTicks: "123456", name: "Synthetic app" };
const emptyStatus = { ...Status, listenAll: true, isCompleted: false, completedAt: null, retainedCount: 0, firstId: 0, lastId: 0 };
const emptyPage: LogPage = { ...fixturePage(), status: emptyStatus, entries: [], matchCount: 0 };
const sampleSession: SessionInfo = {
  id: "demo-session", name: SampleSessionName, startedAt: Status.startedAt, completedAt: Status.completedAt,
  entryCount: 6, exitCode: null, command: null, arguments: [], workingDirectory: "", isCurrent: false
};
let preferences = structuredClone(DefaultPreferences);
const refresh = vi.fn();

beforeEach(() => {
  preferences = structuredClone(DefaultPreferences);
  sessionStorage.clear();
  refresh.mockClear();
  vi.mocked(useLiveStatus).mockReturnValue({ status: emptyStatus, connection: "live", error: null, gap: null, reconnect: vi.fn(), applyStatus: vi.fn() });
  vi.mocked(useLogPage).mockReturnValue({ page: emptyPage, loading: false, error: null, refresh });
  vi.spyOn(api, "appSettings").mockImplementation(async changes => {
    if (changes) preferences = mergePreferences(preferences, changes);
    return { preferences, hasPreferences: true };
  });
  vi.spyOn(api, "appUpdate").mockResolvedValue({
    currentVersion: "1.9.6", automaticCheck: false, release: null, updateAvailable: false,
    installationUnavailableReason: null, installedVersion: null
  });
  vi.spyOn(api, "fetchSessions").mockResolvedValue([]);
  vi.spyOn(api, "saveSessionFilters").mockResolvedValue();
  vi.spyOn(api, "fetchApplications").mockResolvedValue({ applications: [app], selected: null, error: null });
  vi.spyOn(api, "selectApplication").mockResolvedValue({ applications: [app], selected: app, error: null });
  vi.spyOn(api, "clearSessionLogs");
  vi.spyOn(api, "sendInput");
});

describe("first useful log", () => {
  it("offers three explicit paths without attaching, clearing history, or starting a command", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    render(<App />);
    expect(screen.getByRole("heading", { name: "Get your first useful log" })).toBeDefined();
    const choose = screen.getByRole("button", { name: "Choose running app" });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Running app" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(choose);
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Running app" }));
    expect(screen.getByRole("button", { name: "Import a session" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Try sample logs" })).toBeDefined();
    expect(document.getElementById("emptyState")?.textContent).toContain("cannot recover historical stdout/stderr");
    expect(document.getElementById("emptyState")?.textContent).toContain("Microsoft-Extensions-Logging");
    expect(api.selectApplication).not.toHaveBeenCalled();
    expect(api.clearSessionLogs).not.toHaveBeenCalled();
    expect(api.sendInput).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Scrollable log entries").scrollTop).toBe(0);
  });

  it("persists dismissal, reopens from Help, and returns keyboard focus after Escape", async () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss getting started" }));
    await waitFor(() => expect(preferences.onboardingDismissed).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Help" }));
    expect(screen.queryByRole("heading", { name: "Get your first useful log" })).toBeNull();
    first.unmount();
    render(<App />);
    await screen.findByRole("heading", { name: "Ready for logs" });
    const help = screen.getByRole("button", { name: "Help" });
    help.focus();
    fireEvent.click(help);
    const dialog = screen.getByRole("dialog", { name: "Getting started" });
    expect(within(dialog).getByText(/requires the .NET logging EventSource provider/)).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(help));
    expect(preferences.onboardingDismissed).toBe(true);
    expect(api.clearSessionLogs).not.toHaveBeenCalled();
  });

  it("returns focus to inline Import and routes Help actions after its focus trap closes", async () => {
    render(<App />);
    const opener = screen.getByRole("button", { name: "Import a session" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    const help = screen.getByRole("button", { name: "Help" });
    help.focus();
    fireEvent.click(help);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Choose running app" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Running app" })));
    help.focus();
    fireEvent.click(help);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Import a session" }));
    await screen.findByRole("dialog", { name: "Import a session" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(help));
    expect(api.selectApplication).not.toHaveBeenCalled();
  });

  it("imports a bundled synthetic demo as a saved session and supports filtering it", async () => {
    const demoEntry = { ...Entry, message: "[DEMO] Payment timeout for synthetic order 42." };
    vi.mocked(useLogPage).mockImplementation(query => ({
      page: query.sessionId ? { ...fixturePage(demoEntry), status: { ...Status, applicationName: SampleSessionName } } : emptyPage,
      loading: false, error: null, refresh
    }));
    const imported = vi.spyOn(api, "importSessionFile").mockResolvedValue(sampleSession);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample logs" }));
    await screen.findByRole("row", { name: /Payment timeout/ });
    const [file, name] = imported.mock.calls[0]!;
    expect(name).toBe(SampleSessionName);
    const contents = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(file);
    });
    const entries = contents.trim().split("\n").map(line => JSON.parse(line));
    expect(entries).toHaveLength(6);
    expect(entries.every(entry => entry.message.startsWith("[DEMO]") && entry.category.startsWith("Demo."))).toBe(true);
    expect(sampleLogsFile().size).toBeLessThan(4096);
    expect(document.activeElement).toBe(screen.getByLabelText("Search logs"));
    fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "timeout" } });
    await waitFor(() => expect(api.saveSessionFilters).toHaveBeenCalledWith("demo-session", sessionFilters({ ...defaultQuery(), search: "timeout" })));
    expect(api.selectApplication).not.toHaveBeenCalled();
    expect(api.clearSessionLogs).not.toHaveBeenCalled();
    expect(api.sendInput).not.toHaveBeenCalled();
  });

  it("guards duplicate demo requests and reports import failure with a retry path", async () => {
    let reject!: (error: Error) => void;
    const imported = vi.spyOn(api, "importSessionFile").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
      .mockResolvedValue(sampleSession);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample logs" }));
    expect(screen.getByRole("button", { name: "Loading demo…" }).hasAttribute("disabled")).toBe(true);
    expect(imported).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Disk unavailable")));
    expect(screen.getByRole("alert").textContent).toContain("Could not open sample logs: Disk unavailable");
    expect(vi.mocked(useLogPage).mock.lastCall?.[0].sessionId).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Try sample logs" }));
    await waitFor(() => expect(vi.mocked(useLogPage).mock.lastCall?.[0].sessionId).toBe("demo-session"));
  });

  it("distinguishes no apps found and refreshes discovery without attaching", async () => {
    vi.mocked(api.fetchApplications).mockResolvedValueOnce({ applications: [], selected: null, error: null })
      .mockResolvedValue({ applications: [app], selected: null, error: null });
    render(<App />);
    await screen.findByText(/No apps found. Start a .NET app yourself/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh apps" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh apps" })).toBeNull());
    expect(api.selectApplication).not.toHaveBeenCalled();
  });

  it("transitions from attachment with no events to a useful log", async () => {
    vi.mocked(api.fetchApplications).mockResolvedValue({ applications: [app], selected: app, error: null });
    const view = render(<App />);
    await screen.findByRole("heading", { name: "Attached, waiting for events" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Choose another app" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Running app" }));
    vi.mocked(useLogPage).mockReturnValue({ page: fixturePage(), loading: false, error: null, refresh });
    view.rerender(<App />);
    expect(screen.getByRole("row", { name: /Hello/ })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Attached, waiting for events" })).toBeNull();
  });

  it("resets a saved session's no-match filters without changing session, page size, or history", async () => {
    preferences.explorer.pageSize = 500;
    vi.mocked(api.fetchSessions).mockResolvedValue([sampleSession]);
    vi.mocked(useLogPage).mockImplementation(query => ({
      page: query.sessionId && !query.search && !query.dismissedThrough ? fixturePage() : { ...emptyPage, status: Status },
      loading: false, error: null, refresh
    }));
    render(<App />);
    await waitFor(() => expect(vi.mocked(useLogPage).mock.lastCall?.[0].pageSize).toBe(500));
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    fireEvent.click(await screen.findByRole("button", { name: "View session" }));
    fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "no-such-message" } });
    await screen.findByRole("heading", { name: "No matching entries" });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(vi.mocked(useLogPage).mock.lastCall?.[0]).toEqual({ ...defaultQuery(), sessionId: sampleSession.id, pageSize: 500 });
    expect(screen.getByRole("row", { name: /Hello/ })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText("Search logs"));
    expect(api.clearSessionLogs).not.toHaveBeenCalled();
  });

  it("restores entries hidden by Clear view without deleting them", async () => {
    vi.mocked(useLiveStatus).mockReturnValue({ status: Status, connection: "live", error: null, gap: null, reconnect: vi.fn(), applyStatus: vi.fn() });
    vi.mocked(useLogPage).mockImplementation(query => ({
      page: query.dismissedThrough ? { ...emptyPage, status: Status } : fixturePage(),
      loading: false, error: null, refresh
    }));
    render(<App />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Explorer options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear view (this tab)" }));
    expect(screen.getByRole("heading", { name: "No matching entries" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(vi.mocked(useLogPage).mock.lastCall?.[0].dismissedThrough).toBe(0);
    expect(screen.getByRole("row", { name: /Hello/ })).toBeDefined();
    expect(api.clearSessionLogs).not.toHaveBeenCalled();
  });

  it("preserves empty-state keyboard focus while refreshing a valid page", async () => {
    vi.mocked(useLogPage).mockReturnValue({ page: { ...emptyPage, status: Status }, loading: false, error: null, refresh });
    const view = render(<App />);
    const reset = screen.getByRole("button", { name: "Reset filters" });
    reset.focus();
    vi.mocked(useLogPage).mockReturnValue({ page: { ...emptyPage, status: Status }, loading: true, error: null, refresh });
    view.rerender(<App />);
    expect(screen.getByRole("button", { name: "Reset filters" })).toBe(reset);
    expect(document.activeElement).toBe(reset);
    await act(async () => undefined);
  });

  it.each([
    { archived: true, paused: false, matchCount: 0, title: "This session has no entries", action: "Import a session" },
    { archived: false, paused: true, matchCount: 0, title: "Live updates are paused", action: "Resume live updates" },
    { archived: false, paused: false, matchCount: 2, title: "No entries on this page", action: "Show newest matches" }
  ])("provides the next action for $title", ({ archived, paused, matchCount, title, action }) => {
    const next = vi.fn();
    render(<LogEmptyState status={emptyStatus} archived={archived} paused={paused} listening matchCount={matchCount}
      gettingStarted={null} onReset={vi.fn()} onRefresh={vi.fn()} onNewest={next} onChooseApp={vi.fn()} onImport={next} onResume={next} />);
    expect(screen.getByRole("heading", { name: title })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ["loading", "Searching disk history…"],
    ["failure", "Couldn’t load history"]
  ])("does not disguise a %s request as onboarding", async (state, heading) => {
    vi.mocked(useLogPage).mockReturnValue({ page: null, loading: state === "loading", error: state === "failure" ? "Read failed" : null, refresh });
    render(<App />);
    expect(screen.getByRole("heading", { name: heading })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Try sample logs" })).toBeNull();
    await act(async () => undefined);
  });

  it("guides wrapped-command users without offering attachment in that mode", async () => {
    vi.mocked(useLiveStatus).mockReturnValue({ status: { ...emptyStatus, listenAll: false }, connection: "live", error: null, gap: null, reconnect: vi.fn(), applyStatus: vi.fn() });
    vi.mocked(useLogPage).mockReturnValue({ page: { ...emptyPage, status: { ...emptyStatus, listenAll: false } }, loading: false, error: null, refresh });
    render(<App />);
    expect(screen.getByRole("heading", { name: "Waiting for command output" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Choose running app" })).toBeNull();
    expect(within(dialog).getByText(/To attach to a running app/)).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Try sample logs" })).toBeDefined();
    await act(async () => undefined);
  });
});
