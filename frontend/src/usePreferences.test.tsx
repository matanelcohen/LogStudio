import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { DefaultPreferences, DefaultTypography, mergePreferences, TypographyStorageKey, type AppPreferences } from "./preferences";
import { usePreferences } from "./usePreferences";

let stored: AppPreferences | null;

beforeEach(() => {
  stored = null;
  history.replaceState(null, "", "/");
  localStorage.clear();
  vi.spyOn(api, "appSettings").mockImplementation(async changes => {
    if (changes) stored = mergePreferences(stored ?? DefaultPreferences, changes);
    return { preferences: stored ?? structuredClone(DefaultPreferences), hasPreferences: stored !== null };
  });
});
afterEach(() => { history.replaceState(null, "", "/"); localStorage.clear(); });

describe("app-managed preferences", () => {
  it("does not overwrite saved settings with startup defaults, including in StrictMode", async () => {
    stored = mergePreferences(DefaultPreferences, {
      appearance: "monokai", typography: { logFontSize: 24 },
      explorer: { wrap: false, pageSize: 500, timeline: true, columnOrder: [...DefaultPreferences.explorer.columnOrder].reverse() }
    });
    const { result } = renderHook(usePreferences, { wrapper: StrictMode });
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(result.current.settings).toEqual(stored);
    expect(api.appSettings).not.toHaveBeenCalledWith(expect.any(Object));
  });

  it("autosaves changes and restores them at a new server address without browser storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Storage blocked"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = renderHook(usePreferences);
    await waitFor(() => expect(first.result.current.saved).toBe(true));
    act(() => first.result.current.update({
      appearance: "dark-modern", typography: { uiFont: "verdana", uiFontSize: 18, logFontSize: 22 },
      explorer: { fields: true, wrap: false, columnVisibility: { severity: false }, columnSizing: { category: 240 } }
    }));
    await waitFor(() => expect(first.result.current.saved).toBe(true));
    const expected = first.result.current.settings;
    first.unmount();
    history.replaceState(null, "", "/another-viewer/");
    const second = renderHook(usePreferences);
    await waitFor(() => expect(second.result.current.saved).toBe(true));
    expect(second.result.current.settings).toEqual(expected);
    expect(stored).toEqual(expected);
  });

  it("migrates legacy typography once, but never replaces existing app preferences", async () => {
    localStorage.setItem(TypographyStorageKey, JSON.stringify({ ...DefaultTypography, logFontSize: 20 }));
    const first = renderHook(usePreferences);
    await waitFor(() => expect(first.result.current.saved).toBe(true));
    expect(stored?.typography.logFontSize).toBe(20);
    first.unmount();
    localStorage.setItem(TypographyStorageKey, JSON.stringify({ ...DefaultTypography, logFontSize: 24 }));
    const second = renderHook(usePreferences);
    await waitFor(() => expect(second.result.current.saved).toBe(true));
    expect(second.result.current.settings.typography.logFontSize).toBe(20);
  });

  it("honors a bookmarked URL theme and saves system preference explicitly", async () => {
    stored = mergePreferences(DefaultPreferences, { appearance: "dark" });
    history.replaceState(null, "", "/?clawpilotTheme=solarized-light&keep=yes");
    const { result } = renderHook(usePreferences);
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(result.current.settings.appearance).toBe("solarized-light");
    expect(stored?.appearance).toBe("solarized-light");
    act(() => result.current.update({ appearance: "system" }));
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(stored?.appearance).toBe("system");
  });

  it("merges edits made during restore without losing saved settings in the same group", async () => {
    stored = mergePreferences(DefaultPreferences, { typography: { uiFont: "serif" }, explorer: { fields: true } });
    let finish!: (value: Awaited<ReturnType<typeof api.appSettings>>) => void;
    vi.mocked(api.appSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(usePreferences);
    act(() => result.current.update({ typography: { logFontSize: 18 }, explorer: { wrap: false } }));
    expect(api.appSettings).toHaveBeenCalledTimes(1);
    await act(async () => finish({ preferences: stored!, hasPreferences: true }));
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(result.current.settings.typography.uiFont).toBe("serif");
    expect(result.current.settings.typography.logFontSize).toBe(18);
    expect(result.current.settings.explorer.fields).toBe(true);
    expect(result.current.settings.explorer.wrap).toBe(false);
    expect(stored).toEqual(result.current.settings);
  });

  it("serializes rapid changes and coalesces pending fields instead of saving stale values", async () => {
    const { result } = renderHook(usePreferences);
    await waitFor(() => expect(result.current.saved).toBe(true));
    let finish!: (value: Awaited<ReturnType<typeof api.appSettings>>) => void;
    vi.mocked(api.appSettings).mockImplementationOnce(changes => {
      stored = mergePreferences(DefaultPreferences, changes!);
      return new Promise(resolve => { finish = resolve; });
    });
    act(() => {
      result.current.update({ typography: { logFontSize: 18 } });
      result.current.update({ typography: { logFontSize: 20 } });
      result.current.update({ typography: { uiFontSize: 18 }, explorer: { wrap: false } });
    });
    expect(api.appSettings).toHaveBeenCalledTimes(2);
    expect(result.current.saved).toBe(false);
    await act(async () => finish({ preferences: stored!, hasPreferences: true }));
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(api.appSettings).toHaveBeenCalledTimes(3);
    expect(stored?.typography).toEqual({ ...DefaultTypography, logFontSize: 20, uiFontSize: 18 });
    expect(stored?.explorer.wrap).toBe(false);
  });

  it("retains failed edits, reports the error, and retries the newest values", async () => {
    const { result } = renderHook(usePreferences);
    await waitFor(() => expect(result.current.saved).toBe(true));
    vi.mocked(api.appSettings).mockRejectedValueOnce(new Error("Disk is full"));
    act(() => result.current.update({ typography: { logFontSize: 18 } }));
    await waitFor(() => expect(result.current.error).toContain("Disk is full"));
    expect(result.current.settings.typography.logFontSize).toBe(18);
    expect(result.current.saved).toBe(false);
    act(() => result.current.update({ typography: { logFontSize: 22 } }));
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(stored?.typography.logFontSize).toBe(22);
    expect(result.current.error).toBeNull();
  });

  it("does not save defaults after restore fails, and retries without discarding edits", async () => {
    vi.mocked(api.appSettings).mockRejectedValueOnce(new Error("Cannot read settings"));
    const { result } = renderHook(usePreferences);
    await waitFor(() => expect(result.current.error).toContain("Could not restore"));
    act(() => result.current.update({ appearance: "monokai" }));
    expect(api.appSettings).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(stored?.appearance).toBe("monokai");
  });

  it("resets only typography, preserving the theme and explorer preferences", async () => {
    stored = mergePreferences(DefaultPreferences, { appearance: "dark", typography: { logFontSize: 24 }, explorer: { pageSize: 1000 } });
    const { result } = renderHook(usePreferences);
    await waitFor(() => expect(result.current.saved).toBe(true));
    act(() => result.current.update({ typography: { ...DefaultTypography } }));
    await waitFor(() => expect(result.current.saved).toBe(true));
    expect(stored?.typography).toEqual(DefaultTypography);
    expect(stored?.appearance).toBe("dark");
    expect(stored?.explorer.pageSize).toBe(1000);
  });
});
