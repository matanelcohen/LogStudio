import { useLayoutEffect } from "react";
import { LogFonts, UiFonts, type TypographySettings } from "./preferences";
export { DefaultTypography, LogFonts, LogLineHeights, TypographyStorageKey, UiFonts, validateTypography, type TypographySettings } from "./preferences";

export function useTypography(settings: TypographySettings) {
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    const properties = {
      "--ui-font-family": UiFonts.find(font => font.value === settings.uiFont)!.family,
      "--ui-font-size": `${settings.uiFontSize}px`,
      "--ui-font-scale": String(settings.uiFontSize / 14),
      "--log-font-family": LogFonts.find(font => font.value === settings.logFont)!.family,
      "--log-font-size": `${settings.logFontSize}px`,
      "--log-line-height": String(settings.logLineHeight)
    };
    const previous = Object.keys(properties).map(name => ({
      name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name)
    }));
    for (const [name, value] of Object.entries(properties)) style.setProperty(name, value);
    return () => {
      for (const { name, value, priority } of previous) {
        if (value) style.setProperty(name, value, priority);
        else style.removeProperty(name);
      }
    };
  }, [settings]);
}
