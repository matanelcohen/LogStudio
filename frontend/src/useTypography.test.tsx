import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DefaultTypography, LogFonts, UiFonts, useTypography, validateTypography } from "./useTypography";

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

describe("typography styling", () => {
  it("defaults interface and log text to 14px", () => {
    renderHook(() => useTypography(DefaultTypography));
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--ui-font-size")).toBe("14px");
    expect(style.getPropertyValue("--ui-font-scale")).toBe("1");
    expect(style.getPropertyValue("--log-font-size")).toBe("14px");
  });

  it("applies independent root tokens when preferences change", () => {
    const settings = { ...DefaultTypography, uiFont: "verdana" as const, uiFontSize: 18, logFont: "menlo" as const, logFontSize: 24, logLineHeight: 2 as const };
    const first = renderHook(useTypography, { initialProps: DefaultTypography });
    first.rerender(settings);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--ui-font-family")).toBe(UiFonts[2].family);
    expect(style.getPropertyValue("--ui-font-size")).toBe("18px");
    expect(style.getPropertyValue("--ui-font-scale")).toBe(String(18 / 14));
    expect(style.getPropertyValue("--log-font-family")).toBe(LogFonts[2].family);
    expect(style.getPropertyValue("--log-font-size")).toBe("24px");
    expect(style.getPropertyValue("--log-line-height")).toBe("2");
    first.unmount();
    renderHook(() => useTypography(settings));
    expect(style.getPropertyValue("--log-font-size")).toBe("24px");
  });

  it("restores default styles when typography is reset", () => {
    const hook = renderHook(useTypography, { initialProps: { ...DefaultTypography, uiFontSize: 18, logFontSize: 24 } });
    hook.rerender(DefaultTypography);
    expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("14px");
    expect(document.documentElement.style.getPropertyValue("--log-font-size")).toBe("14px");
  });

  it("restores previous document styling on unmount", () => {
    const style = document.documentElement.style;
    style.setProperty("--ui-font-size", "18px");
    style.setProperty("--log-font-size", "16px", "important");
    const { unmount } = renderHook(() => useTypography(DefaultTypography));
    expect(style.getPropertyValue("--ui-font-size")).toBe("14px");
    expect(style.getPropertyValue("--log-font-size")).toBe("14px");
    unmount();
    expect(style.getPropertyValue("--ui-font-size")).toBe("18px");
    expect(style.getPropertyValue("--log-font-size")).toBe("16px");
    expect(style.getPropertyPriority("--log-font-size")).toBe("important");
    style.removeProperty("--ui-font-size");
    style.removeProperty("--log-font-size");
  });
});
