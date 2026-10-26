import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { Entry, fixturePage, Status } from "./test-fixtures";
import { useLiveStatus, useLogPage } from "./useLogExplorer";
import { DefaultTypography, LogFonts, TypographyStorageKey, UiFonts } from "./useTypography";
import { AppearanceOptions, ColorThemes } from "./themes";
import * as api from "./api";
import { defaultQuery, sessionFilters, type ChatResponse, type LogEntry, type RunningApplicationsState } from "./model";
import { DefaultPreferences, mergePreferences } from "./preferences";

const reconnect = vi.hoisted(() => vi.fn());
const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
let savedPreferences = structuredClone(DefaultPreferences);

beforeEach(() => {
  savedPreferences = structuredClone(DefaultPreferences);
  vi.spyOn(api, "appSettings").mockImplementation(async changes => {
    if (changes) savedPreferences = mergePreferences(savedPreferences, changes);
    return { preferences: savedPreferences, hasPreferences: true };
  });
  localStorage.removeItem(TypographyStorageKey);
  sessionStorage.clear();
  vi.spyOn(api, "fetchSessions").mockResolvedValue([]);
  vi.spyOn(api, "saveSessionFilters").mockResolvedValue();
  vi.spyOn(api, "fetchCopilotHistory").mockResolvedValue([]);
  vi.spyOn(api, "appUpdate").mockResolvedValue({
    currentVersion: "1.8.1", automaticCheck: false, release: null, updateAvailable: false,
    installationUnavailableReason: null, installedVersion: null
  });
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
  it("persists named searches across viewer reloads and applies filters without adopting another session or page size", async () => {
    const first = render(<App />);
    fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "timeout" } });
    fireEvent.click(screen.getByRole("button", { name: "Saved searches" }));
    fireEvent.change(screen.getByLabelText("Search name"), { target: { value: "Timeouts" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current filters" }));
    await waitFor(() => expect(savedPreferences.savedSearches).toEqual([{ name: "Timeouts", filters: sessionFilters({ ...defaultQuery(), search: "timeout" }) }]));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    first.unmount();
    render(<App />);
    await waitFor(() => expect(api.appSettings).toHaveBeenCalledWith(undefined, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Saved searches" }));
    fireEvent.click(await screen.findByRole("button", { name: "Timeouts" }));
    await waitFor(() => expect(vi.mocked(useLogPage).mock.lastCall?.[0]).toEqual({
      ...defaultQuery(), search: "timeout"
    }));
    expect(screen.queryByRole("dialog", { name: "Saved searches" })).toBeNull();
  });

  it("keeps inspector navigation and the highlighted log row synchronized", async () => {
    const second = { ...Entry, id: 2, message: "second entry" };
    vi.mocked(useLogPage).mockReturnValue({ page: { ...fixturePage(), entries: [Entry, second] }, loading: false, error: null, refresh: vi.fn() });
    try {
      render(<App />);
      const pane = screen.getByLabelText("Scrollable log entries");
      vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 200));
      vi.spyOn(document.querySelector("thead")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 40));
      vi.spyOn(document.querySelector('[data-log-id="1"]')!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 140, 500, 30));
      vi.spyOn(document.querySelector('[data-log-id="2"]')!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 330, 500, 30));
      fireEvent.click(screen.getByRole("row", { name: /Hello/ }));
      fireEvent.click(screen.getByRole("button", { name: "Next entry" }));
      expect(document.getElementById("detailId")?.textContent).toBe("2");
      expect(document.querySelector('[data-log-id="2"]')?.getAttribute("aria-selected")).toBe("true");
      expect(pane.scrollTop).toBe(60);
      expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
      await act(async () => undefined);
    } finally {
      vi.mocked(useLogPage).mockReturnValue({ page: fixturePage(), loading: false, error: null, refresh: vi.fn() });
    }
  });

  it("restores saved fonts, theme, page size and explorer layout in a fresh viewer", async () => {
    history.replaceState(null, "", "/");
    savedPreferences = mergePreferences(DefaultPreferences, {
      appearance: "monokai", typography: { uiFontSize: 16, logFontSize: 20 },
      explorer: {
        wrap: false, fields: true, inspector: true, timeline: true, pageSize: 500,
        columnOrder: [...DefaultPreferences.explorer.columnOrder].reverse(),
        columnVisibility: { severity: false, id: false, stream: false }, columnSizing: { category: 240 }
      }
    });
    const first = render(<App />);
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("20px"));
    expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("16px");
    expect(document.documentElement.dataset.colorTheme).toBe("monokai");
    expect(screen.getByRole("button", { name: "Available fields" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Toggle timeline" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Toggle inspector" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("columnheader")[0]!.textContent).toContain("Message");
    expect(screen.queryByRole("columnheader", { name: /Level/ })).toBeNull();
    await waitFor(() => expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[0].pageSize).toBe(500));
    fireEvent.click(screen.getByRole("button", { name: "Available fields" }));
    await waitFor(() => expect(savedPreferences.explorer.fields).toBe(false));
    first.unmount();
    history.replaceState(null, "", "/");
    render(<App />);
    await waitFor(() => expect(document.documentElement.dataset.colorTheme).toBe("monokai"));
    expect(screen.getByRole("button", { name: "Available fields" }).getAttribute("aria-pressed")).toBe("false");
    expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("20px");
    history.replaceState(null, "", "/");
  });

  describe("color theme pickers", () => {
    beforeEach(() => history.replaceState(null, "", "/"));
    afterEach(() => history.replaceState(null, "", "/"));

    it("offers the same themes in the header and Settings and applies changes immediately", async () => {
      render(<App />);
      fireEvent.keyDown(screen.getByRole("button", { name: "Appearance" }), { key: "Enter" });
      const choices = await screen.findAllByRole("menuitemradio");
      expect(choices.map(choice => choice.textContent)).toEqual(AppearanceOptions.map(option => option.label));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Monokai" }));
      expect(document.documentElement.dataset.colorTheme).toBe("monokai");
      expect(document.documentElement.dataset.theme).toBe("dark");
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      const appearance = screen.getByRole("combobox", { name: "Appearance mode" });
      expect(appearance.textContent).toBe("Monokai");
      fireEvent.keyDown(appearance, { key: "Enter" });
      expect((await screen.findAllByRole("option")).map(option => option.textContent))
        .toEqual(AppearanceOptions.map(option => option.label));
      fireEvent.keyDown(screen.getByRole("option", { name: "Light High Contrast" }), { key: "Enter" });
      expect(document.documentElement.dataset.colorTheme).toBe("light-high-contrast");
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.themeContrast).toBe("high");
      expect(new URLSearchParams(location.search).get("clawpilotTheme")).toBe("light-high-contrast");
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      fireEvent.keyDown(screen.getByRole("button", { name: "Appearance" }), { key: "Enter" });
      expect(screen.getByRole("menuitemradio", { name: "Light High Contrast" }).getAttribute("aria-checked")).toBe("true");
      fireEvent.click(screen.getByRole("menuitemradio", { name: "System preference" }));
      expect(document.documentElement.dataset.colorTheme).toBeUndefined();
      expect(document.documentElement.dataset.themeContrast).toBeUndefined();
      expect(location.search).toBe("");
    });

    it("maps each palette token to the workspace and keeps high-contrast surfaces opaque", () => {
      const { container } = render(<style>{styles}</style>);
      const rules = Array.from(container.querySelector("style")!.sheet!.cssRules)
        .filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
      const palette = rules.find(rule => rule.selectorText === "html[data-color-theme]")!.style;
      for (const key of Object.keys(ColorThemes[0].palette)) {
        expect(palette.cssText).toContain(`var(--theme-${key})`);
      }
      for (const property of ["--cp-surface", "--cp-shell-material", "--cp-content-material", "--cp-panel-strong"]) {
        expect(palette.getPropertyValue(property)).not.toContain("transparent");
      }
      expect(palette.getPropertyValue("--cp-native-accent")).toBe("var(--theme-link)");
      expect(palette.getPropertyValue("--cp-button-accent")).toBe("var(--theme-accent)");
      expect(palette.getPropertyValue("--cp-wallpaper")).toBe("none");
      const highContrast = rules.find(rule => rule.selectorText === 'html[data-theme-contrast="high"]')!.style;
      expect(highContrast.getPropertyValue("--cp-window-shadow")).toBe("none");
      expect(styles).toMatch(/html\[data-theme-contrast="high"\] \*\s*\{[^}]*backdrop-filter:\s*none;/);
    });
  });

  it("opens release notes from the update notification without installing", async () => {
    vi.mocked(api.appUpdate).mockResolvedValue({
      currentVersion: "1.8.1", automaticCheck: true, updateAvailable: true, installationUnavailableReason: null, installedVersion: null,
      release: { version: "1.9.0", name: "Log Studio 1.9.0", notes: "Improved capture reliability.",
        url: "https://github.com/matanelcohen/LogStudio/releases/tag/1.9.0", publishedAt: "2026-10-24T10:00:00Z" }
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Update available" }));
    expect(screen.getByLabelText("Release notes").textContent).toContain("Improved capture reliability.");
    expect(api.appUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses a non-destructive OUI notice for clearing only the current view", async () => {
    render(<App />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Explorer options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear view (this tab)" }));
    const notice = screen.getByText("Existing entries are hidden in this tab only. Reset restores disk history.").closest("[data-slot='alert']");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.classList.contains("oui:text-destructive")).toBe(false);
  });

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
      vi.mocked(useLogPage).mockReturnValue({ page: fixturePage(), loading: false, error: null, refresh: vi.fn() });
    });

    async function openApplications() {
      const dropdown = screen.getByRole("combobox", { name: "Running app" });
      await waitFor(() => expect(dropdown.hasAttribute("disabled")).toBe(false));
      fireEvent.keyDown(dropdown, { key: "Enter" });
      await screen.findByRole("listbox");
      return dropdown;
    }

    async function chooseApplication(name: string | RegExp) {
      await openApplications();
      fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" });
    }

    async function pollApplications() {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }

    it("refreshes discovery every two seconds without selecting the only running app", async () => {
      vi.useFakeTimers();
      const select = vi.spyOn(api, "selectApplication");
      await act(async () => { render(<App />); });
      const dropdown = screen.getByRole("combobox", { name: "Running app" });
      expect(dropdown.textContent).toBe("Choose a running app");
      expect(screen.getByText("Choose an app")).toBeDefined();
      expect(screen.queryByRole("searchbox", { name: "Find running app" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh apps" })).toBeNull();
      expect(screen.queryByText("Disk-backed history")).toBeNull();
      expect(document.querySelector(".workspace-context")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
      expect(api.fetchApplications).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(api.fetchApplications).toHaveBeenCalledTimes(2);
      await pollApplications();
      expect(api.fetchApplications).toHaveBeenCalledTimes(3);
      expect(dropdown.textContent).toBe("Choose a running app");
      expect(select).not.toHaveBeenCalled();
    });

    it("discovers newly started apps while the dropdown is open without changing the selection", async () => {
      vi.useFakeTimers();
      vi.mocked(api.fetchApplications).mockResolvedValueOnce(waiting)
        .mockResolvedValue({ ...waiting, applications: [application, worker] });
      const select = vi.spyOn(api, "selectApplication");
      await act(async () => { render(<App />); });
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Running app" }), { key: "Enter" });
      expect(screen.getAllByRole("option")).toHaveLength(1);
      await pollApplications();
      expect(screen.getByRole("option", { name: "Example.Worker (PID 43)" })).toBeDefined();
      expect(screen.getAllByRole("option")).toHaveLength(2);
      expect(select).not.toHaveBeenCalled();
    });

    it("recovers from a discovery failure on the next background refresh", async () => {
      vi.useFakeTimers();
      vi.mocked(api.fetchApplications).mockRejectedValueOnce(new Error("Discovery unavailable.")).mockResolvedValue(waiting);
      await act(async () => { render(<App />); });
      expect(screen.getByRole("alert").textContent).toContain("Discovery unavailable.");
      expect(screen.getByRole("combobox", { name: "Running app" }).hasAttribute("disabled")).toBe(true);
      await pollApplications();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("combobox", { name: "Running app" }).hasAttribute("disabled")).toBe(false);
    });

    it("stops background discovery when the picker is unmounted", async () => {
      vi.useFakeTimers();
      const { unmount } = await act(async () => render(<App />));
      const signal = vi.mocked(api.fetchApplications).mock.calls.at(0)?.[0];
      expect(api.fetchApplications).toHaveBeenCalledTimes(1);
      unmount();
      expect(signal?.aborted).toBe(true);
      await pollApplications();
      expect(api.fetchApplications).toHaveBeenCalledTimes(1);
    });

    it("distinguishes app groups by their paths and PIDs and separates .NET tooling", async () => {
      const other = { ...group, processId: 50, groupId: "path:/another workspace/Example.Api.dll", path: "/another workspace/Example.Api.dll", processes: [{ ...application, processId: 50 }] };
      const tooling = { ...application, processId: 60, name: "MSBuild", isTool: true };
      vi.mocked(api.fetchApplications).mockResolvedValue({ ...waiting, applications: [group, other, tooling] });
      const select = vi.spyOn(api, "selectApplication");
      render(<App />);
      await openApplications();
      const apiGroup = screen.getByRole("option", { name: "Example.Api · 2 processes" });
      expect(within(apiGroup).getByText("/repo/Example.Api.dll · PIDs 42, 43")).toBeDefined();
      expect(document.getElementById(apiGroup.getAttribute("aria-describedby")!)?.textContent).toContain("/repo/Example.Api.dll · PIDs 42, 43");
      const otherGroup = screen.getByRole("option", { name: "Example.Api · 1 process" });
      expect(within(otherGroup).getByText("/another workspace/Example.Api.dll · PIDs 50")).toBeDefined();
      expect(otherGroup.getAttribute("aria-describedby")).not.toMatch(/\s/);
      expect(screen.getByRole("group", { name: ".NET tooling" }).textContent).toContain("MSBuild");
      expect(screen.getAllByRole("option")).toHaveLength(3);
      expect(select).not.toHaveBeenCalled();
    });

    it("selects the entire app and exposes the captured process paths", async () => {
      const grouped = { ...waiting, applications: [group] };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce(grouped).mockResolvedValue({ ...grouped, selected: group });
      vi.spyOn(api, "selectApplication").mockResolvedValue({ ...grouped, selected: group });
      render(<App />);
      await chooseApplication("Example.Api · 2 processes");
      await screen.findByText("Listening to Example.Api · 2 processes");
      expect(api.selectApplication).toHaveBeenCalledExactlyOnceWith(group);
      expect(screen.getByRole("combobox", { name: "Running app" }).textContent).toBe("Example.Api · 2 processes");
      expect(screen.getByText("PID 43")).toBeDefined();
      expect(screen.getByText("/repo/Example.Worker.dll")).toBeDefined();
    });

    it("keeps the selected group and a paused investigation when the lead PID changes", async () => {
      vi.useFakeTimers();
      const updated = { ...group, processId: worker.processId, startedAtTicks: worker.startedAtTicks, processes: [worker] };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ ...waiting, applications: [group], selected: group })
        .mockResolvedValue({ ...waiting, applications: [updated], selected: updated });
      const select = vi.spyOn(api, "selectApplication");
      await act(async () => { render(<App />); });
      expect(screen.getByText("Listening to Example.Api · 2 processes")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Keep my query" } });
      await pollApplications();
      expect(screen.getByText("Listening to Example.Api · 1 process")).toBeDefined();
      expect(screen.getByRole("combobox", { name: "Running app" }).textContent).toBe("Example.Api · 1 process");
      expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
      expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("Keep my query");
      expect(select).not.toHaveBeenCalled();
      expect(screen.queryByText("PID 42")).toBeNull();
    });

    it("makes partial capture explicit while opening the successfully attached group", async () => {
      const partial = { ...waiting, applications: [group], selected: { ...group, processes: [worker] }, error: "Could not attach to PID 42." };
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ ...waiting, applications: [group] }).mockResolvedValue(partial);
      vi.spyOn(api, "selectApplication").mockResolvedValue(partial);
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await chooseApplication("Example.Api · 2 processes");
      await screen.findByText("Listening to Example.Api · 1 process");
      expect(screen.getByRole("alert").textContent).toContain("Could not attach to PID 42.");
      expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Retry app" })).toBeDefined();
    });

    it("clears a partial attachment warning when the missing process connects", async () => {
      vi.useFakeTimers();
      const partial = { ...waiting, applications: [group], selected: { ...group, processes: [worker] }, error: "Could not attach to PID 42." };
      vi.mocked(api.fetchApplications).mockResolvedValue(partial);
      await act(async () => { render(<App />); });
      expect(screen.getByRole("button", { name: "Retry app" })).toBeDefined();
      vi.mocked(api.fetchApplications).mockResolvedValue({ ...waiting, applications: [group], selected: group });
      await pollApplications();
      expect(screen.getByText("Listening to Example.Api · 2 processes")).toBeDefined();
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
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await chooseApplication("Example.Api (PID 42)");
      await screen.findByText("Listening to Example.Api");
      expect(api.selectApplication).toHaveBeenCalledExactlyOnceWith(application);
      expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
      expect(reconnect).not.toHaveBeenCalled();
    });

    it("waits for the live history switch instead of refreshing and resetting the previous app", async () => {
      const first = { ...Status, listenAll: true, isCompleted: false };
      const applyStatus = vi.fn();
      const refresh = vi.fn();
      const firstPage = fixturePage();
      vi.mocked(useLogPage).mockReturnValue({ page: firstPage, loading: false, error: null, refresh });
      vi.mocked(useLiveStatus).mockReturnValue({
        status: first, connection: "live", error: null, gap: null, reconnect, applyStatus
      });
      const applications = [application, worker];
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ applications, selected: application, error: null })
        .mockResolvedValue({ applications, selected: worker, error: null });
      vi.spyOn(api, "selectApplication").mockResolvedValue({ applications, selected: worker, error: null });
      const { rerender } = render(<App />);
      await screen.findByText("Listening to Example.Api");
      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Previous app query" } });
      await chooseApplication("Example.Worker (PID 43)");
      await screen.findByText("Listening to Example.Worker");
      expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("Previous app query");
      expect(refresh).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
      vi.mocked(useLiveStatus).mockReturnValue({
        status: { ...first, historyDirectory: "/private/temp/another-app", revision: first.revision + 1 },
        connection: "live", error: null, gap: null, reconnect, applyStatus
      });
      rerender(<App />);
      expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("");
      expect(document.querySelector(".workspace-layout")?.hasAttribute("inert")).toBe(true);
      expect(screen.getByText("Loading selected application history…")).toBeDefined();
      expect(document.querySelector("#rows")?.textContent).toContain(Entry.message);
      const next = { ...Entry, message: "Worker history" };
      vi.mocked(useLogPage).mockReturnValue({
        page: { ...fixturePage(next), status: { ...first, historyDirectory: "/private/temp/another-app" } },
        loading: false, error: null, refresh
      });
      rerender(<App />);
      expect(document.querySelector(".workspace-layout")?.hasAttribute("inert")).toBe(false);
      expect(screen.queryByText("Loading selected application history…")).toBeNull();
      expect(document.querySelector("#rows")?.textContent).toContain(next.message);
    });

    it("resets app-local view checkpoints when another tab switches the capture history", async () => {
      const first = { ...Status, listenAll: true, isCompleted: false, clearedThroughId: 100 };
      vi.mocked(useLiveStatus).mockReturnValue({
        status: first, connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
      });
      const { rerender } = render(<App />);
      await screen.findByRole("combobox", { name: "Running app" });
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Only the first app" } });
      vi.mocked(useLiveStatus).mockReturnValue({
        status: { ...first, historyDirectory: "/private/temp/another-app", clearedThroughId: 0, lastId: 1, revision: first.revision + 1 },
        connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
      });
      rerender(<App />);
      expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
      expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("");
      expect(vi.mocked(useLogPage).mock.calls.at(-1)?.slice(2)).toEqual([
        null, first.revision + 1, false, 0, "/private/temp/another-app"
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      vi.mocked(useLiveStatus).mockReturnValue({
        status: { ...first, historyDirectory: "/private/temp/another-app", clearedThroughId: 1, lastId: 1, revision: first.revision + 2 },
        connection: "live", error: null, gap: null, reconnect, applyStatus: vi.fn()
      });
      rerender(<App />);
      expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
    });

    it("keeps saved sessions interactive while a different live app is selected", async () => {
      vi.mocked(api.fetchSessions).mockResolvedValue([{
        id: "saved", name: "Saved run", startedAt: Status.startedAt, completedAt: Status.completedAt,
        exitCode: 0, entryCount: 1, command: "dotnet", arguments: [], workingDirectory: "", isCurrent: false
      }]);
      vi.mocked(useLogPage).mockImplementation(query => ({
        page: { ...fixturePage(), status: { ...Status, historyDirectory: query.sessionId ? "/private/saved" : Status.historyDirectory } },
        loading: false, error: null, refresh: vi.fn()
      }));
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
      fireEvent.click(await screen.findByRole("button", { name: "View session" }));
      expect(document.querySelector(".workspace-layout")?.hasAttribute("inert")).toBe(false);
      expect(screen.queryByText("Loading selected application history…")).toBeNull();
      expect(screen.getByRole("table", { name: "Captured logs" })).toBeDefined();
    });

    it("does not reset the new app's investigation when the previous app's clear finishes", async () => {
      let finish!: (result: { deletedCount: number; status: typeof Status }) => void;
      vi.spyOn(api, "clearSessionLogs").mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const applyStatus = vi.fn();
      const first = { ...Status, listenAll: true, isCompleted: false };
      vi.mocked(useLiveStatus).mockReturnValue({
        status: first, connection: "live", error: null, gap: null, reconnect, applyStatus
      });
      const { rerender } = render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Clear logs" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete session logs" }));
      vi.mocked(useLiveStatus).mockReturnValue({
        status: { ...first, historyDirectory: "/private/temp/another-app", revision: first.revision + 1 },
        connection: "live", error: null, gap: null, reconnect, applyStatus
      });
      rerender(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await act(async () => finish({ deletedCount: first.lastId, status: { ...first, clearedThroughId: first.lastId } }));
      expect(applyStatus).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
      expect(screen.queryByText(/Deleted .* session entries/)).toBeNull();
    });

    it("keeps a failed selection visible after refreshing discovery", async () => {
      vi.spyOn(api, "selectApplication").mockRejectedValue(new Error("The application exited."));
      render(<App />);
      await chooseApplication("Example.Api (PID 42)");
      await waitFor(() => expect(api.fetchApplications).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("alert").textContent).toContain("The application exited.");
      expect(screen.getByRole("combobox", { name: "Running app" }).textContent).toBe("Choose a running app");
    });

    it("shows empty discovery without attaching", async () => {
      vi.mocked(api.fetchApplications).mockResolvedValue({ ...waiting, applications: [] });
      const select = vi.spyOn(api, "selectApplication");
      render(<App />);
      await screen.findByText("No running .NET apps found");
      expect(screen.getByText("Waiting for you to choose an app.")).toBeDefined();
      expect(select).not.toHaveBeenCalled();
    });

    it("shows an existing selection on reload but does not attach a replacement when it exits", async () => {
      vi.useFakeTimers();
      vi.mocked(api.fetchApplications).mockResolvedValueOnce({ ...waiting, selected: application }).mockResolvedValue(waiting);
      const select = vi.spyOn(api, "selectApplication");
      await act(async () => { render(<App />); });
      expect(screen.getByText("Listening to Example.Api")).toBeDefined();
      await pollApplications();
      expect(screen.getByText("Waiting for you to choose an app.")).toBeDefined();
      expect(screen.getByRole("combobox", { name: "Running app" }).textContent).toBe("Choose a running app");
      expect(select).not.toHaveBeenCalled();
    });

    it("does not reset a paused investigation when the collector reports an attachment error", async () => {
      vi.spyOn(api, "selectApplication").mockResolvedValue({ ...waiting, error: "Attaching timed out." });
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Keep my query" } });
      await chooseApplication("Example.Api (PID 42)");
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

  it("resizes the log table without losing the selected entry or open panels", () => {
    let resize = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    render(<App />);
    const scroll = screen.getByLabelText("Scrollable log entries");
    const table = screen.getByRole("table", { name: "Captured logs" });
    fireEvent.click(screen.getByRole("button", { name: "Available fields" }));
    fireEvent.click(screen.getByRole("row", { name: /Hello/ }));

    for (const width of [1200, 720, 420, 1600]) {
      Object.defineProperty(scroll, "clientWidth", { configurable: true, value: width });
      act(() => resize());
      const columnsWidth = Array.from(table.querySelectorAll("col")).reduce((sum, column) => sum + parseFloat(column.style.width), 0);
      expect(columnsWidth).toBe(Math.max(620, width));
      expect(screen.getByRole("complementary", { name: "Entry inspector" }).textContent).toContain(Entry.message);
      expect(screen.getByRole("complementary", { name: "Discover fields" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Toggle inspector" }).getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("keeps narrow and short workspaces scrollable and adapts panels to their available width", () => {
    const { container } = render(<><style>{styles}</style><App /></>);
    const rules = Array.from(container.querySelector("style")!.sheet!.cssRules);
    function declaration(rules: CSSRule[], selector: string, property: string) {
      return rules.filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE)
        .filter(rule => rule.selectorText.split(",").map(value => value.trim()).includes(selector))
        .map(rule => rule.style.getPropertyValue(property)).filter(Boolean).at(-1);
    }
    expect(declaration(rules, ".app", "min-width")).toBe("0");
    expect(declaration(rules, ".app", "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(declaration(rules, ".app", "grid-template-rows")).toBe("max-content max-content minmax(376px, 1fr) max-content");
    expect(declaration(rules, ".app", "overflow")).toBe("auto");
    for (const selector of [".header-actions", ".search-row", ".table-tools", ".paging", ".app-footer", ".workspace-region"]) {
      expect(declaration(rules, selector, "flex-wrap"), selector).toBe("wrap");
    }
    for (const selector of [".condition-dialog", ".clear-dialog", ".sessions-dialog", ".session-management-panel", ".import-dialog", ".settings-dialog", ".menu-content", ".popover"]) {
      expect(declaration(rules, selector, "max-height"), selector).toContain("100dvh");
      expect(declaration(rules, selector, "overflow"), selector).toBe("auto");
    }
    expect(declaration(rules, ".workspace", "container")).toBe("log-workspace / inline-size");
    const narrow = rules.find((rule): rule is CSSContainerRule =>
      rule.cssText.startsWith("@container log-workspace (max-width: 760px)"))!;
    expect(declaration(Array.from(narrow.cssRules), ".workspace > .workspace-layout", "flex-direction")).toBe("column");
    expect(declaration(Array.from(narrow.cssRules), ".workspace > .workspace-layout", "overflow")).toBe("auto");
    expect(container.querySelector(".workspace > .workspace-layout > .log-panel")).not.toBeNull();
  });

  describe("compact investigation controls", () => {
    function compactViewport() {
      const matchMedia = window.matchMedia;
      let compact = true;
      const listeners = new Set<() => void>();
      vi.stubGlobal("matchMedia", (query: string) => query === "(max-width: 900px), (max-height: 500px)" ? {
        ...matchMedia(query),
        get matches() { return compact; },
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
      } : matchMedia(query));
      return (value: boolean) => act(() => { compact = value; listeners.forEach(listener => listener()); });
    }

    it("keeps session identity, pause, import, settings and export reachable with focus restoration", async () => {
      compactViewport();
      render(<App />);
      expect(screen.getByRole("button", { name: "Sessions" }).textContent).toContain(Status.applicationName);
      expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();

      for (const [action, title, close] of [
        ["Import", "Import a session", "Cancel"],
        ["Settings", "Settings", "Done"]
      ]) {
        const opener = screen.getByRole("button", { name: "Session actions" });
        fireEvent.click(opener);
        fireEvent.click(screen.getByRole("button", { name: action }));
        const dialog = screen.getByRole("dialog", { name: title });
        expect(screen.queryByRole("dialog", { name: "Session actions" })).toBeNull();
        fireEvent.click(within(dialog).getByRole("button", { name: close }));
        await waitFor(() => expect(document.activeElement).toBe(opener));
      }

      fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "alpha" } });
      const row = screen.getByRole("row", { name: /Hello/ });
      row.focus();
      fireEvent.keyDown(row, { key: "Enter" });
      expect(screen.getByRole("complementary", { name: "Entry inspector" }).textContent).toContain(Entry.message);
      fireEvent.click(screen.getByRole("button", { name: "Query actions" }));
      const download = screen.getByRole("link", { name: "Export" });
      expect(download.getAttribute("href")).toContain("q=alpha");
      expect(download.getAttribute("href")).toContain(`maxId=${Status.lastId}`);
      fireEvent.keyDown(screen.getByRole("button", { name: "Export options" }), { key: "Enter" });
      expect((await screen.findByRole("menuitem", { name: /Spreadsheet/ })).getAttribute("href")).toContain("format=csv");
    });

    it("keeps active filters visible while their editors are disclosed", async () => {
      compactViewport();
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Filter error entries" }));
      expect(screen.getByLabelText("Active filters").textContent).toContain("Levels: error, critical");
      expect(screen.queryByRole("button", { name: "Level" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Filters · 1 active" }));
      expect(screen.getByRole("button", { name: "Level" })).toBeDefined();
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Stream" }), { key: "Enter" });
      fireEvent.keyDown(await screen.findByRole("option", { name: "stdout" }), { key: "Enter" });
      expect(screen.getByLabelText("Active filters").textContent).toContain("Stream: stdout");
    });

    it.each([
      [false, false], [true, false], [false, true], [true, true]
    ])("preserves selection and panel state across compact/wide transitions (fields=%s, chat=%s)", async (fields, chat) => {
      const resize = compactViewport();
      vi.spyOn(api, "connectCopilot").mockResolvedValue({ version: "test CLI", models: [] });
      render(<App />);
      const row = screen.getByRole("row", { name: /Hello/ });
      fireEvent.keyDown(row, { key: "Enter" });
      const inspector = screen.getByRole("complementary", { name: "Entry inspector" });
      if (fields) fireEvent.click(screen.getByRole("button", { name: "Available fields" }));
      const fieldPanel = screen.queryByRole("complementary", { name: "Discover fields" });
      if (fieldPanel) fireEvent.change(screen.getByLabelText("Find a field"), { target: { value: "message" } });
      if (chat) {
        fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
        fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
        fireEvent.change(screen.getByLabelText("Message Copilot"), { target: { value: "Investigation draft" } });
      }
      const chatPanel = screen.queryByRole("complementary", { name: "Ask Copilot about logs" });
      for (const compact of [false, true, false]) {
        resize(compact);
        expect(screen.getByRole("row", { name: /Hello/ })).toBe(row);
        expect(row.getAttribute("aria-selected")).toBe("true");
        expect(screen.getByRole("complementary", { name: "Entry inspector" })).toBe(inspector);
        expect(screen.queryByRole("complementary", { name: "Discover fields" })).toBe(fieldPanel);
        expect(screen.queryByRole("complementary", { name: "Ask Copilot about logs" })).toBe(chatPanel);
        if (fields) expect((screen.getByLabelText("Find a field") as HTMLInputElement).value).toBe("message");
        if (chat) expect((screen.getByLabelText("Message Copilot") as HTMLTextAreaElement).value).toBe("Investigation draft");
      }
      const layout = document.querySelector(".workspace-layout")!;
      expect(layout.firstElementChild?.classList.contains("log-panel")).toBe(true);
      if (chatPanel) expect(chatPanel.previousElementSibling?.classList.contains("workspace")).toBe(true);
      await waitFor(() => expect(savedPreferences.explorer.inspector).toBe(true));
      expect(savedPreferences.explorer.fields).toBe(fields);
    });
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

  it("opens Copilot in a non-modal panel after the log results, even with no visible matches", () => {
    vi.mocked(useLogPage).mockReturnValueOnce({ page: { ...fixturePage(), entries: [] }, loading: false, error: null, refresh: vi.fn() });
    render(<App />);
    expect(screen.queryByRole("heading", { name: "Ask Copilot about logs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    expect(screen.getByRole("heading", { name: "Ask Copilot about logs" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Connect local Copilot" })).toBeNull();
    const panel = screen.getByRole("complementary", { name: "Ask Copilot about logs" });
    expect(panel.parentElement).toBe(screen.getByRole("main", { name: "Log exploration workspace" }));
    expect(panel.previousElementSibling?.classList.contains("workspace")).toBe(true);
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
    expect(screen.getByLabelText("Match case").getAttribute("aria-checked")).toBe("true");
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

  it("uses OUI surface tokens and preserves opaque accessibility fallbacks", () => {
    const { container } = render(<><style>{styles}</style><App /></>);
    const rules = Array.from(container.querySelector("style")!.sheet!.cssRules);
    function declaration(rules: CSSRule[], selector: string, property: string) {
      return rules.filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE)
        .filter(rule => rule.selectorText.split(",").map(value => value.trim()).includes(selector))
        .map(rule => rule.style.getPropertyValue(property)).filter(Boolean).at(-1);
    }
    expect(declaration(rules, ".discover-shell", "background")).toBe("var(--cp-shell-material)");
    expect(declaration(rules, ":root", "--cp-surface")).toBe("var(--oui-card)");
    expect(declaration(rules, ":root", "--cp-native-accent")).toBe("var(--cp-accent)");
    expect(declaration(rules, ":root", "--cp-accent")).toBe("var(--oui-primary)");
    expect(declaration(rules, ":root", "--cp-wallpaper")).toBe("none");
    expect(declaration(rules, "html[data-color-theme]", "--oui-primary")).toBe("var(--theme-accent)");
    expect(screen.getByRole("region", { name: "Search and filter logs" }).getAttribute("data-slot")).toBe("card");
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
    for (const selector of [".select-trigger", ".field-row", ".muted", ".copilot-copy", ".telemetry-status"]) {
      expect(fontSize(selector), selector).toBe("var(--ui-font-size, 14px)");
    }
    expect(rules.find(rule => rule.selectorText === ":root")?.style.getPropertyValue("--oui-text-sm")).toBe("var(--ui-font-size, 14px)");
    for (const selector of [".logs-scroll tbody", ".logs-scroll .severity-badge", ".message-lines", ".message", "#detailMessage", ".selected-details .metadata", ".selected-details .severity-badge"]) {
      expect(fontSize(selector), selector).toBe("var(--log-font-size, 14px)");
    }
    expect(fontSize(".category-cell")).toBeUndefined();
    expect(container.querySelector(".category-cell")?.closest("tbody")).not.toBeNull();
    expect(rules.find(rule => rule.selectorText === ".selected-details .metadata")?.style.getPropertyValue("grid-template-columns"))
      .toBe("minmax(0, 7em) minmax(0, 1fr)");
    expect(rules.find(rule => rule.selectorText === ".metadata dt")?.style.getPropertyValue("overflow-wrap")).toBe("anywhere");
  });

  describe("typography settings", () => {
    async function openSettings() {
      render(<App />);
      const search = screen.getByLabelText("Search logs") as HTMLInputElement;
      fireEvent.change(search, { target: { value: "Hello" } });
      const opener = screen.getByRole("button", { name: "Settings" });
      fireEvent.click(opener);
      const dialog = screen.getByRole("dialog", { name: "Settings" });
      expect((await within(dialog).findByText("All settings saved.")).tagName).toBe("P");
      return { search, opener, dialog, settings: within(dialog) };
    }

    it.each([
      { label: "UI font", option: "Verdana", changes: { uiFont: "verdana" },
        property: "--ui-font-family", value: UiFonts.find(font => font.value === "verdana")!.family },
      { label: "UI font size", option: "18 px", changes: { uiFontSize: 18 },
        property: "--ui-font-size", value: "18px" },
      { label: "Log font", option: "Courier New", changes: { logFont: "courier" },
        property: "--log-font-family", value: LogFonts.find(font => font.value === "courier")!.family },
      { label: "Log font size", option: "24 px", changes: { logFontSize: 24 },
        property: "--log-font-size", value: "24px" },
      { label: "Log line spacing", option: "Spacious", changes: { logLineHeight: 2 },
        property: "--log-line-height", value: "2" }
    ])("applies and saves $label immediately without changing the query", async ({ label, option, changes, property, value }) => {
      const { search, settings } = await openSettings();
      expect(settings.getByLabelText("Log font preview").textContent).toContain("Application started");
      const scroll = screen.getByLabelText("Scrollable log entries");
      Object.defineProperty(scroll, "scrollHeight", { value: 500, configurable: true });

      fireEvent.keyDown(settings.getByRole("combobox", { name: label }), { key: "Enter" });
      const listbox = await screen.findByRole("listbox");
      fireEvent.keyDown(within(listbox).getByRole("option", { name: option }), { key: "Enter" });

      expect(document.documentElement.style.getPropertyValue(property)).toBe(value);
      expect(scroll.scrollTop).toBe(500);
      await waitFor(() => expect(savedPreferences.typography).toEqual({ ...DefaultTypography, ...changes }));
      expect(search.value).toBe("Hello");
      expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[0].search).toBe("Hello");
    });

    it("resets typography without changing the query and restores focus on dismissal", async () => {
      savedPreferences = mergePreferences(DefaultPreferences, {
        typography: { uiFont: "verdana", uiFontSize: 18, logFont: "courier", logFontSize: 24, logLineHeight: 2 }
      });
      const { search, opener, dialog, settings } = await openSettings();
      expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("18px");
      expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("24px");
      fireEvent.click(settings.getByRole("button", { name: "Reset typography" }));
      await waitFor(() => expect(savedPreferences.typography).toEqual(DefaultTypography));
      expect(settings.getByRole("combobox", { name: "UI font size" }).textContent).toContain("14 px");
      expect(settings.getByRole("combobox", { name: "Log font size" }).textContent).toContain("14 px");
      expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("14px");
      expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("14px");
      expect(document.documentElement.style.getPropertyValue("--log-line-height")).toBe(String(DefaultTypography.logLineHeight));
      expect(search.value).toBe("Hello");
      expect(vi.mocked(useLogPage).mock.calls.at(-1)?.[0].search).toBe("Hello");
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
    });
  });

  it("shows an app autosave warning without disabling settings", async () => {
    render(<App />);
    await waitFor(() => expect(api.appSettings).toHaveBeenCalled());
    vi.mocked(api.appSettings).mockRejectedValue(new Error("Disk is full"));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset typography" }));
    expect(await screen.findByText(/Changes work in this tab but have not been saved/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset typography" })).toBeDefined();
  });
});
