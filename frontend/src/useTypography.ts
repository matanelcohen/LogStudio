import { useEffect, useLayoutEffect, useState } from "react";

export const TypographyStorageKey = "logstudio.typography.v1";
export const UiFonts = [
  { value: "system", label: "System sans-serif", family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { value: "arial", label: "Arial", family: "Arial, Helvetica, sans-serif" },
  { value: "verdana", label: "Verdana", family: "Verdana, Geneva, sans-serif" },
  { value: "serif", label: "Georgia", family: 'Georgia, "Times New Roman", serif' }
] as const;
export const LogFonts = [
  { value: "default", label: "Consolas / Courier", family: 'Consolas, "Courier New", Courier, monospace' },
  { value: "system", label: "System monospace", family: "ui-monospace, monospace" },
  { value: "menlo", label: "Menlo / Monaco", family: 'Menlo, Monaco, Consolas, "Courier New", monospace' },
  { value: "courier", label: "Courier New", family: '"Courier New", Courier, monospace' }
] as const;
export const LogLineHeights = [1.3, 1.6, 2] as const;

export interface TypographySettings {
  uiFont: typeof UiFonts[number]["value"];
  uiFontSize: number;
  logFont: typeof LogFonts[number]["value"];
  logFontSize: number;
  logLineHeight: typeof LogLineHeights[number];
}

export const DefaultTypography: Readonly<TypographySettings> = {
  uiFont: "system", uiFontSize: 14, logFont: "default", logFontSize: 14, logLineHeight: 1.6
};

export function validateTypography(value: unknown): TypographySettings {
  const settings = value && typeof value === "object" ? value as Record<string, unknown> : {};
  function size(value: unknown, minimum: number, maximum: number, fallback: number) {
    return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
  }
  return {
    uiFont: UiFonts.find(font => font.value === settings.uiFont)?.value ?? DefaultTypography.uiFont,
    uiFontSize: size(settings.uiFontSize, 12, 18, DefaultTypography.uiFontSize),
    logFont: LogFonts.find(font => font.value === settings.logFont)?.value ?? DefaultTypography.logFont,
    logFontSize: size(settings.logFontSize, 10, 24, DefaultTypography.logFontSize),
    logLineHeight: LogLineHeights.find(height => height === settings.logLineHeight) ?? DefaultTypography.logLineHeight
  };
}

function readTypography(): TypographySettings {
  try {
    return validateTypography(JSON.parse(localStorage.getItem(TypographyStorageKey) ?? "null"));
  } catch {
    return { ...DefaultTypography };
  }
}

export function useTypography() {
  const [settings, setSettings] = useState<TypographySettings>(readTypography);
  const [saved, setSaved] = useState(true);

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

  useEffect(() => {
    try {
      localStorage.setItem(TypographyStorageKey, JSON.stringify(settings));
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }, [settings]);

  return {
    settings, saved,
    update: (changes: Partial<TypographySettings>) => setSettings(current => validateTypography({ ...current, ...changes })),
    reset: () => setSettings({ ...DefaultTypography })
  };
}
