import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultTypography, LogFonts, TypographyStorageKey, UiFonts, useTypography, validateTypography } from "./useTypography";

beforeEach(() => localStorage.removeItem(TypographyStorageKey));
afterEach(() => localStorage.removeItem(TypographyStorageKey));

describe("typography validation", () => {
  it.each([null, [], "invalid", 1, {}])("uses defaults for unsupported settings: %j", value => {
    expect(validateTypography(value)).toEqual(DefaultTypography);
  });

  it("rejects arbitrary fonts, invalid sizes, and unsupported line spacing independently", () => {
    expect(validateTypography({
      uiFont: "url(https://example.com/font)", uiFontSize: 19,
      logFont: "unknown", logFontSize: 9, logLineHeight: 0
    })).toEqual(DefaultTypography);
    expect(validateTypography({
      uiFont: "arial", uiFontSize: 12.5,
      logFont: "courier", logFontSize: "16", logLineHeight: 2
    })).toEqual({ ...DefaultTypography, uiFont: "arial", logFont: "courier", logLineHeight: 2 });
  });

  it.each([NaN, Infinity, -Infinity, -1])("rejects unsafe numeric sizes: %s", value => {
    expect(validateTypography({ uiFontSize: value, logFontSize: value })).toEqual(DefaultTypography);
  });

  it("accepts the supported size bounds", () => {
    expect(validateTypography({ uiFontSize: 12, logFontSize: 10 })).toEqual({ ...DefaultTypography, uiFontSize: 12, logFontSize: 10 });
    expect(validateTypography({ uiFontSize: 18, logFontSize: 24 })).toEqual({ ...DefaultTypography, uiFontSize: 18, logFontSize: 24 });
  });
});

describe("saved typography", () => {
  it("applies independent root tokens and restores saved preferences on remount", () => {
    const settings = { ...DefaultTypography, uiFont: "verdana" as const, uiFontSize: 18, logFont: "menlo" as const, logFontSize: 24, logLineHeight: 2 as const };
    const first = renderHook(useTypography);
    act(() => first.result.current.update(settings));
    expect(first.result.current.settings).toEqual(settings);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--ui-font-family")).toBe(UiFonts[2].family);
    expect(style.getPropertyValue("--ui-font-scale")).toBe(String(18 / 13));
    expect(style.getPropertyValue("--log-font-family")).toBe(LogFonts[2].family);
    expect(style.getPropertyValue("--log-font-size")).toBe("24px");
    expect(style.getPropertyValue("--log-line-height")).toBe("2");
    expect(JSON.parse(localStorage.getItem(TypographyStorageKey)!)).toEqual(settings);
    first.unmount();
    const second = renderHook(useTypography);
    expect(second.result.current.settings).toEqual(settings);
  });

  it.each(["{broken", "null", '{"uiFontSize":999,"logFontSize":-1}'])("recovers from corrupt storage: %s", value => {
    localStorage.setItem(TypographyStorageKey, value);
    const { result } = renderHook(useTypography);
    expect(result.current.settings).toEqual(DefaultTypography);
  });

  it("resets only typography, leaving other stored preferences intact", () => {
    localStorage.setItem("other-preference", "keep");
    const { result } = renderHook(useTypography);
    act(() => result.current.update({ uiFontSize: 18, logFont: "courier", logFontSize: 24, logLineHeight: 2 }));
    act(() => result.current.reset());
    expect(result.current.settings).toEqual(DefaultTypography);
    expect(JSON.parse(localStorage.getItem(TypographyStorageKey)!)).toEqual(DefaultTypography);
    expect(localStorage.getItem("other-preference")).toBe("keep");
    localStorage.removeItem("other-preference");
  });

  it("still applies changes when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage blocked"); });
    const { result } = renderHook(useTypography);
    act(() => result.current.update({ logFontSize: 20 }));
    expect(result.current.saved).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("20px");
  });

  it("uses defaults when storage reads fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Storage blocked"); });
    const { result } = renderHook(useTypography);
    expect(result.current.settings).toEqual(DefaultTypography);
  });

  it("restores previous document styling on unmount", () => {
    const style = document.documentElement.style;
    style.setProperty("--log-font-size", "16px", "important");
    const { unmount } = renderHook(useTypography);
    expect(style.getPropertyValue("--log-font-size")).toBe("12px");
    unmount();
    expect(style.getPropertyValue("--log-font-size")).toBe("16px");
    expect(style.getPropertyPriority("--log-font-size")).toBe("important");
    style.removeProperty("--log-font-size");
  });
});
