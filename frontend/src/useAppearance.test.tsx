import { StrictMode, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceOptions, ColorThemes } from "./themes";
import { useAppearance as useControlledAppearance } from "./useAppearance";
import { urlAppearance } from "./preferences";

function useAppearance() {
  const [appearance, setAppearance] = useState(() => urlAppearance() ?? "system");
  return useControlledAppearance(appearance, setAppearance);
}

beforeEach(() => history.replaceState(null, "", "/"));
afterEach(() => history.replaceState(null, "", "/"));

function systemPreference(prefersDark = false) {
  const media = Object.assign(new EventTarget(), {
    matches: prefersDark, media: "(prefers-color-scheme: dark)", onchange: null,
    addListener: vi.fn(), removeListener: vi.fn()
  }) satisfies MediaQueryList;
  vi.stubGlobal("matchMedia", () => media);
  return media;
}

describe("color themes", () => {
  it("offers the built-in VS Code color themes alongside the original modes", () => {
    expect(ColorThemes.map(theme => theme.label).sort()).toEqual([
      "Abyss", "Dark (Visual Studio)", "Dark High Contrast", "Dark Modern", "Dark+", "Dark 2026",
      "Kimbie Dark", "Light (Visual Studio)", "Light High Contrast", "Light Modern", "Light+", "Light 2026",
      "Monokai", "Monokai Dimmed", "Quiet Light", "Red", "Solarized Dark", "Solarized Light", "Tomorrow Night Blue"
    ].sort());
    expect(new Set(AppearanceOptions.map(option => option.value)).size).toBe(AppearanceOptions.length);
  });

  it.each(AppearanceOptions)("restores $label from its URL", option => {
    history.replaceState(null, "", `/?clawpilotTheme=${option.value}&keep=value#logs`);
    const { result } = renderHook(useAppearance, { wrapper: StrictMode });
    expect(result.current.appearance).toBe(option.value);
    expect(result.current.theme).toBe(option.scheme === "system" ? "light" : option.scheme);
    expect(document.documentElement.dataset.theme).toBe(result.current.theme);
    expect(document.documentElement.classList.contains("dark")).toBe(result.current.theme === "dark");
    expect(location.search).toContain("keep=value");
    expect(location.hash).toBe("#logs");
    const selected = ColorThemes.find(theme => theme.value === option.value);
    expect(document.documentElement.dataset.colorTheme).toBe(selected?.value);
    for (const [key, color] of Object.entries(selected?.palette ?? {})) {
      expect(document.documentElement.style.getPropertyValue(`--theme-${key}`)).toBe(color);
    }
  });

  it.each(["", "?clawpilotTheme=unsupported", "?clawpilotTheme=url(https://example.com)"])(
    "follows system appearance for a missing or unsupported theme: %s", query => {
      const media = systemPreference(true);
      const add = vi.spyOn(media, "addEventListener");
      const remove = vi.spyOn(media, "removeEventListener");
      history.replaceState(null, "", `/${query}`);
      const { result, unmount } = renderHook(useAppearance);
      expect(result.current.appearance).toBe("system");
      expect(result.current.theme).toBe("dark");
      expect(location.search).toBe("");
      act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
      expect(result.current.theme).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      act(() => { media.matches = true; document.dispatchEvent(new Event("visibilitychange")); });
      expect(result.current.theme).toBe("dark");
      unmount();
      expect(remove).toHaveBeenCalledWith("change", add.mock.calls[0]![1]);
    }
  );

  it("keeps a manual palette when the system changes and restores it on reload", () => {
    const media = systemPreference();
    history.replaceState(null, "", "/?keep=value#logs");
    const first = renderHook(useAppearance);
    act(() => first.result.current.setAppearance("monokai"));
    expect(first.result.current.theme).toBe("dark");
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
    expect(first.result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.colorTheme).toBe("monokai");
    expect(new URLSearchParams(location.search).get("clawpilotTheme")).toBe("monokai");
    first.unmount();
    const second = renderHook(useAppearance);
    expect(second.result.current.appearance).toBe("monokai");
    act(() => second.result.current.setAppearance("system"));
    expect(second.result.current.theme).toBe("light");
    expect(location.search).toBe("?keep=value");
    expect(location.hash).toBe("#logs");
    expect(document.documentElement.dataset.colorTheme).toBeUndefined();
  });

  it("switches whole palettes and removes overrides when returning to an original mode", () => {
    const { result } = renderHook(useAppearance);
    const root = document.documentElement;
    root.style.setProperty("--log-font-size", "20px");
    act(() => result.current.setAppearance("dark-high-contrast"));
    expect(root.dataset.themeContrast).toBe("high");
    expect(root.style.getPropertyValue("--theme-background")).toBe("#000000");
    act(() => result.current.setAppearance("solarized-light"));
    expect(result.current.theme).toBe("light");
    expect(root.dataset.themeContrast).toBeUndefined();
    expect(root.style.getPropertyValue("--theme-background")).toBe("#fdf6e3");
    act(() => result.current.setAppearance("dark"));
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.colorTheme).toBeUndefined();
    expect(Array.from(root.style).filter(property => property.startsWith("--theme-"))).toEqual([]);
    expect(root.style.getPropertyValue("--log-font-size")).toBe("20px");
    root.style.removeProperty("--log-font-size");
  });

  it("restores pre-existing document colors and attributes on unmount", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    root.classList.add("dark");
    root.dataset.colorTheme = "existing";
    root.dataset.themeContrast = "existing";
    root.style.setProperty("--theme-background", "#123456", "important");
    history.replaceState(null, "", "/?clawpilotTheme=abyss");
    const { unmount } = renderHook(useAppearance);
    expect(root.dataset.colorTheme).toBe("abyss");
    unmount();
    expect(root.dataset.theme).toBe("light");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.colorTheme).toBe("existing");
    expect(root.dataset.themeContrast).toBe("existing");
    expect(root.style.getPropertyValue("--theme-background")).toBe("#123456");
    expect(root.style.getPropertyPriority("--theme-background")).toBe("important");
    delete root.dataset.theme;
    delete root.dataset.colorTheme;
    delete root.dataset.themeContrast;
    root.style.removeProperty("--theme-background");
    root.classList.remove("dark");
  });

  it.each(ColorThemes.filter(theme => "highContrast" in theme))(
    "provides accessible text, controls and borders for $label", ({ palette }) => {
      function luminance(hex: string) {
        const channels = hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255)
          .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      }
      function contrast(first: string, second: string) {
        const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
        return (values[1]! + 0.05) / (values[0]! + 0.05);
      }
      for (const background of [palette.background, palette.sidebar, palette.input]) {
        expect(contrast(palette.foreground, background)).toBeGreaterThanOrEqual(7);
        expect(contrast(palette.muted, background)).toBeGreaterThanOrEqual(7);
        expect(contrast(palette.link, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.border, background)).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(palette.accentForeground, palette.accent)).toBeGreaterThanOrEqual(4.5);
    }
  );
});
