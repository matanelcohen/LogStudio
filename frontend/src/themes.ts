export interface ThemePalette {
  background: string;
  sidebar: string;
  input: string;
  border: string;
  foreground: string;
  muted: string;
  accent: string;
  accentForeground: string;
  link: string;
  success: string;
  warning: string;
  danger: string;
}

interface ColorTheme {
  value: string;
  label: string;
  scheme: "light" | "dark";
  highContrast?: boolean;
  palette: ThemePalette;
}

const VisualStudioDark: ThemePalette = {
  background: "#1e1e1e", sidebar: "#252526", input: "#3c3c3c", border: "#474747",
  foreground: "#d4d4d4", muted: "#a6a6a6", accent: "#0e639c", accentForeground: "#ffffff", link: "#4daafc",
  success: "#89d185", warning: "#cca700", danger: "#f48771"
};
const VisualStudioLight: ThemePalette = {
  background: "#ffffff", sidebar: "#f3f3f3", input: "#ffffff", border: "#cecece",
  foreground: "#000000", muted: "#616161", accent: "#007acc", accentForeground: "#ffffff", link: "#006ab1",
  success: "#388a34", warning: "#895503", danger: "#b5200d"
};

// Adapted from VS Code's built-in palettes; the upstream MIT notice ships with the viewer.
export const ColorThemes = [
  {
    value: "light-2026", label: "Light 2026", scheme: "light",
    palette: {
      background: "#ffffff", sidebar: "#fafafd", input: "#ffffff", border: "#d7d8dd",
      foreground: "#202020", muted: "#606060", accent: "#0069cc", accentForeground: "#ffffff", link: "#0069cc",
      success: "#237b4b", warning: "#895503", danger: "#b5200d"
    }
  },
  {
    value: "dark-2026", label: "Dark 2026", scheme: "dark",
    palette: {
      background: "#121314", sidebar: "#191a1b", input: "#202122", border: "#444648",
      foreground: "#bbbebf", muted: "#a0a0a0", accent: "#297aa0", accentForeground: "#ffffff", link: "#48a0c7",
      success: "#89d185", warning: "#d7ba7d", danger: "#f48771"
    }
  },
  {
    value: "light-modern", label: "Light Modern", scheme: "light",
    palette: {
      background: "#ffffff", sidebar: "#f8f8f8", input: "#ffffff", border: "#cecece",
      foreground: "#3b3b3b", muted: "#616161", accent: "#005fb8", accentForeground: "#ffffff", link: "#005fb8",
      success: "#388a34", warning: "#895503", danger: "#b5200d"
    }
  },
  {
    value: "dark-modern", label: "Dark Modern", scheme: "dark",
    palette: {
      background: "#1f1f1f", sidebar: "#181818", input: "#313131", border: "#484848",
      foreground: "#cccccc", muted: "#9d9d9d", accent: "#0078d4", accentForeground: "#ffffff", link: "#4daafc",
      success: "#89d185", warning: "#d7ba7d", danger: "#f48771"
    }
  },
  { value: "light-plus", label: "Light+", scheme: "light", palette: VisualStudioLight },
  { value: "dark-plus", label: "Dark+", scheme: "dark", palette: VisualStudioDark },
  { value: "visual-studio-light", label: "Light (Visual Studio)", scheme: "light", palette: VisualStudioLight },
  { value: "visual-studio-dark", label: "Dark (Visual Studio)", scheme: "dark", palette: VisualStudioDark },
  {
    value: "light-high-contrast", label: "Light High Contrast", scheme: "light", highContrast: true,
    palette: {
      background: "#ffffff", sidebar: "#ffffff", input: "#ffffff", border: "#292929",
      foreground: "#000000", muted: "#292929", accent: "#0f4a85", accentForeground: "#ffffff", link: "#0f4a85",
      success: "#185e18", warning: "#663b00", danger: "#a1260d"
    }
  },
  {
    value: "dark-high-contrast", label: "Dark High Contrast", scheme: "dark", highContrast: true,
    palette: {
      background: "#000000", sidebar: "#000000", input: "#000000", border: "#6fc3df",
      foreground: "#ffffff", muted: "#ffffff", accent: "#6fc3df", accentForeground: "#000000", link: "#6fc3df",
      success: "#89d185", warning: "#ffff00", danger: "#ff9999"
    }
  },
  {
    value: "abyss", label: "Abyss", scheme: "dark",
    palette: {
      background: "#000c18", sidebar: "#060621", input: "#181f2f", border: "#354569",
      foreground: "#6688cc", muted: "#879dcc", accent: "#2b3c5d", accentForeground: "#ffffff", link: "#80a2ff",
      success: "#d1f1a9", warning: "#ffddaa", danger: "#ff7882"
    }
  },
  {
    value: "kimbie-dark", label: "Kimbie Dark", scheme: "dark",
    palette: {
      background: "#221a0f", sidebar: "#362712", input: "#51412c", border: "#84613d",
      foreground: "#d3af86", muted: "#c4a787", accent: "#6e583b", accentForeground: "#ffffff", link: "#e3b583",
      success: "#a8b572", warning: "#f0c674", danger: "#f28779"
    }
  },
  {
    value: "monokai", label: "Monokai", scheme: "dark",
    palette: {
      background: "#272822", sidebar: "#1e1f1c", input: "#414339", border: "#75715e",
      foreground: "#f8f8f2", muted: "#b5b29e", accent: "#75715e", accentForeground: "#ffffff", link: "#a6e22e",
      success: "#a6e22e", warning: "#e6db74", danger: "#ff6188"
    }
  },
  {
    value: "monokai-dimmed", label: "Monokai Dimmed", scheme: "dark",
    palette: {
      background: "#1e1e1e", sidebar: "#272727", input: "#353535", border: "#707070",
      foreground: "#c5c8c6", muted: "#a5a8a6", accent: "#565656", accentForeground: "#ffffff", link: "#9aa9eb",
      success: "#b5bd68", warning: "#f0c674", danger: "#e99594"
    }
  },
  {
    value: "quiet-light", label: "Quiet Light", scheme: "light",
    palette: {
      background: "#f5f5f5", sidebar: "#f2f2f2", input: "#ffffff", border: "#c4c4c4",
      foreground: "#333333", muted: "#626262", accent: "#705697", accentForeground: "#ffffff", link: "#705697",
      success: "#4b7434", warning: "#805b19", danger: "#aa3731"
    }
  },
  {
    value: "red", label: "Red", scheme: "dark",
    palette: {
      background: "#390000", sidebar: "#330000", input: "#580000", border: "#a34444",
      foreground: "#f8f8f8", muted: "#e7b9b9", accent: "#883333", accentForeground: "#ffffff", link: "#ffb3b3",
      success: "#b9dc8c", warning: "#f0c674", danger: "#ff9999"
    }
  },
  {
    value: "solarized-light", label: "Solarized Light", scheme: "light",
    palette: {
      background: "#fdf6e3", sidebar: "#eee8d5", input: "#fdf6e3", border: "#b49471",
      foreground: "#586e75", muted: "#586e75", accent: "#796c28", accentForeground: "#ffffff", link: "#217caa",
      success: "#526500", warning: "#856000", danger: "#c4352e"
    }
  },
  {
    value: "solarized-dark", label: "Solarized Dark", scheme: "dark",
    palette: {
      background: "#002b36", sidebar: "#00212b", input: "#003847", border: "#586e75",
      foreground: "#93a1a1", muted: "#93a1a1", accent: "#176c66", accentForeground: "#ffffff", link: "#49b9b0",
      success: "#a6b52a", warning: "#d6a923", danger: "#f07169"
    }
  },
  {
    value: "tomorrow-night-blue", label: "Tomorrow Night Blue", scheme: "dark",
    palette: {
      background: "#002451", sidebar: "#001c40", input: "#001733", border: "#44658c",
      foreground: "#ffffff", muted: "#b2c8e3", accent: "#315f95", accentForeground: "#ffffff", link: "#bbdaff",
      success: "#d1f1a9", warning: "#ffddaa", danger: "#ff9da4"
    }
  }
] as const satisfies readonly ColorTheme[];

export const AppearanceOptions = [
  { value: "system", label: "System preference", scheme: "system" },
  { value: "light", label: "Light Mode", scheme: "light" },
  { value: "dark", label: "Dark Mode", scheme: "dark" },
  ...ColorThemes
] as const;

export type Appearance = typeof AppearanceOptions[number]["value"];
export const AppearanceChoices = AppearanceOptions.map(option => option.value);
