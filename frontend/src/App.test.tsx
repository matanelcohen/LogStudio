import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { fixturePage, Status } from "./test-fixtures";
import { useLiveStatus, useLogPage } from "./useLogExplorer";
import { DefaultTypography, TypographyStorageKey } from "./useTypography";
import * as api from "./api";
import type { ChatResponse } from "./model";

const reconnect = vi.hoisted(() => vi.fn());

beforeEach(() => localStorage.removeItem(TypographyStorageKey));
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
  it("preserves Copilot conversation and drafts across logs-to-metrics navigation", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    vi.spyOn(api, "askCopilot").mockResolvedValue({ answer: "Existing answer", contextEntryCount: 1, contextTruncated: false });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      enabled: true, metrics: [], spans: [], droppedMetrics: 0, droppedSpans: 0
    })))));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    const panel = screen.getByRole("complementary", { name: "Ask Copilot about logs" });
    fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
    const input = await screen.findByLabelText("Question about these logs") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "First question" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Ask Copilot" }));
    await screen.findByText("Existing answer");
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
    await screen.findByText("No metric measurements captured yet.");
    expect(panel.isConnected).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(screen.queryByRole("complementary", { name: "Ask Copilot about logs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discover logs" }));
    expect(screen.getByRole("complementary", { name: "Ask Copilot about logs" })).toBe(panel);
    expect(panel.hidden).toBe(false);
    expect(input.value).toBe("Keep this draft");
    expect(screen.getByRole("log").textContent).toContain("First question");
    expect(screen.getByRole("log").textContent).toContain("Existing answer");
  });

  it("retains an in-flight Copilot response while its panel is hidden by telemetry", async () => {
    vi.spyOn(api, "connectCopilot").mockResolvedValue("test CLI");
    let finish!: (value: ChatResponse) => void;
    const ask = vi.spyOn(api, "askCopilot").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      enabled: true, metrics: [], spans: [], droppedMetrics: 0, droppedSpans: 0
    })))));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    const panel = screen.getByRole("complementary", { name: "Ask Copilot about logs" });
    fireEvent.click(screen.getByRole("button", { name: "Connect local Copilot" }));
    const input = await screen.findByLabelText("Question about these logs");
    fireEvent.change(input, { target: { value: "In-flight question" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Ask Copilot" }));
    fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
    await screen.findByText("No metric measurements captured yet.");
    await act(async () => finish({ answer: "Response while hidden", contextEntryCount: 1, contextTruncated: false }));
    fireEvent.click(screen.getByRole("button", { name: "Discover logs" }));
    expect(screen.getByText("Response while hidden")).toBeDefined();
    expect(screen.getByRole("log").textContent).toContain("In-flight question");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close Copilot chat" }).hasAttribute("disabled")).toBe(false);
  });

  it("navigates telemetry only on demand and preserves the log query when returning", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: true, metrics: [], spans: [], droppedMetrics: 0, droppedSpans: 0
    })));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "Hello" } });
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
    expect(screen.getByRole("main", { name: "Metrics workspace" })).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Search logs" })).toBeNull();
    await screen.findByText("No metric measurements captured yet.");
    const signal = fetch.mock.calls[0]?.[1].signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Discover logs" }));
    expect(signal.aborted).toBe(true);
    expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("Hello");
    expect(screen.getByRole("main", { name: "Log exploration workspace" })).toBeDefined();
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
    expect(screen.getByRole("button", { name: "Connect local Copilot" })).toBeDefined();
    const panel = screen.getByRole("complementary", { name: "Ask Copilot about logs" });
    expect(panel.parentElement).toBe(screen.getByRole("main", { name: "Log exploration workspace" }));
    expect(panel.nextElementSibling?.className).toBe("workspace");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Search logs").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close Copilot chat" }));
    expect(screen.queryByRole("complementary", { name: "Ask Copilot about logs" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Ask Copilot" }));
  });

  it("updates the session name while paused without resetting the frozen log cursor", async () => {
    const current = {
      id: "current", name: "Current run", startedAt: "2026-10-12T08:00:00Z",
      completedAt: null, exitCode: null, entryCount: 10, command: "dotnet",
      arguments: [], workingDirectory: "/current", isCurrent: true
    };
    const renamed = { ...current, name: "Paused investigation" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([current])))
      .mockResolvedValueOnce(new Response(JSON.stringify(renamed)))
      .mockResolvedValueOnce(new Response(JSON.stringify([renamed]))));
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

  it("changes typography immediately, keeps the current query, and restores focus on dismissal", async () => {
    render(<App />);
    const search = screen.getByLabelText("Search logs") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Hello" } });
    const opener = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "UI font" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Log font" })).toBeDefined();
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
