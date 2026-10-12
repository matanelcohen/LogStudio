import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { Status } from "./test-fixtures";
import { useLiveStatus, useLogPage } from "./useLogExplorer";
import { DefaultTypography, TypographyStorageKey } from "./useTypography";

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

  it("opens optional Copilot chat only on request", () => {
    render(<App />);
    expect(screen.queryByRole("heading", { name: "Ask Copilot about logs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
    expect(screen.getByRole("heading", { name: "Ask Copilot about logs" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Connect local Copilot" })).toBeDefined();
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
