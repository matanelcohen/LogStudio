import { useEffect, useState } from "react";

export const AppearanceChoices = ["system", "light", "dark"] as const;
export type Appearance = typeof AppearanceChoices[number];
const ThemeParameter = "clawpilotTheme";
const ColorSchemeQuery = "(prefers-color-scheme: dark)";

function initialAppearance(): Appearance {
  const value = new URLSearchParams(location.search).get(ThemeParameter);
  return value === "light" || value === "dark" ? value : "system";
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    initialAppearance() === "dark" || (initialAppearance() === "system" && matchMedia(ColorSchemeQuery).matches) ? "dark" : "light");

  useEffect(() => {
    const media = matchMedia(ColorSchemeQuery);
    function apply() {
      const theme = appearance === "system" ? media.matches ? "dark" : "light" : appearance;
      document.documentElement.dataset.theme = theme;
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
    };
  }, [appearance]);
  return { appearance, setAppearance, theme };
}
