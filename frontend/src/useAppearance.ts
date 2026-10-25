import { useEffect, useState } from "react";
import { AppearanceChoices, ColorThemes, type Appearance } from "./themes";

const ThemeParameter = "clawpilotTheme";
const ColorSchemeQuery = "(prefers-color-scheme: dark)";

function initialAppearance(): Appearance {
  const value = new URLSearchParams(location.search).get(ThemeParameter);
  return AppearanceChoices.find(choice => choice === value) ?? "system";
}

function colorScheme(appearance: Appearance, prefersDark: boolean): "light" | "dark" {
  if (appearance === "system") return prefersDark ? "dark" : "light";
  return ColorThemes.find(theme => theme.value === appearance)?.scheme ?? (appearance === "dark" ? "dark" : "light");
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    colorScheme(appearance, matchMedia(ColorSchemeQuery).matches));

  useEffect(() => {
    const root = document.documentElement;
    const media = matchMedia(ColorSchemeQuery);
    const selected = ColorThemes.find(theme => theme.value === appearance);
    const previousTheme = root.dataset.theme;
    const previousColorTheme = root.dataset.colorTheme;
    const previousContrast = root.dataset.themeContrast;
    const previousProperties = Object.entries(selected?.palette ?? {}).map(([key, value]) => {
      const property = `--theme-${key}`;
      const previous = root.style.getPropertyValue(property);
      const priority = root.style.getPropertyPriority(property);
      root.style.setProperty(property, value);
      return { property, previous, priority };
    });
    if (selected) root.dataset.colorTheme = selected.value;
    else delete root.dataset.colorTheme;
    if (selected && "highContrast" in selected && selected.highContrast) root.dataset.themeContrast = "high";
    else delete root.dataset.themeContrast;
    function apply() {
      const theme = colorScheme(appearance, media.matches);
      root.dataset.theme = theme;
      setTheme(theme);
    }
    const url = new URL(location.href);
    if (appearance === "system") url.searchParams.delete(ThemeParameter);
    else url.searchParams.set(ThemeParameter, appearance);
    history.replaceState(null, "", url);
    apply();
    media.addEventListener("change", apply);
    document.addEventListener("visibilitychange", apply);
    return () => {
      media.removeEventListener("change", apply);
      document.removeEventListener("visibilitychange", apply);
      for (const { property, previous, priority } of previousProperties) {
        if (previous) root.style.setProperty(property, previous, priority);
        else root.style.removeProperty(property);
      }
      if (previousTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previousTheme;
      if (previousColorTheme === undefined) delete root.dataset.colorTheme;
      else root.dataset.colorTheme = previousColorTheme;
      if (previousContrast === undefined) delete root.dataset.themeContrast;
      else root.dataset.themeContrast = previousContrast;
    };
  }, [appearance]);
  return { appearance, setAppearance, theme };
}
