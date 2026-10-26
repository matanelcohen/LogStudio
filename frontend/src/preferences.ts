import { MaximumPageSize, PageSize, type SessionFilters } from "./model";
import { readSessionFilters } from "./sessionFilters";
import { AppearanceChoices, type Appearance } from "./themes";

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

export const DefaultColumnOrder = ["id", "timestamp", "severity", "stream", "category", "message"];
export const DefaultColumnVisibility: Record<string, boolean> = { id: false, stream: false };

export interface ExplorerPreferences {
  wrap: boolean;
  pageSize: number;
  fields: boolean;
  inspector: boolean;
  timeline: boolean;
  columnOrder: string[];
  columnVisibility: Record<string, boolean>;
  columnSizing: Record<string, number>;
}

export interface AppPreferences {
  appearance: Appearance;
  onboardingDismissed: boolean;
  typography: TypographySettings;
  explorer: ExplorerPreferences;
  savedSearches: SavedSearch[];
}

export const MaximumSavedSearches = 10;
export interface SavedSearch { name: string; filters: SessionFilters; }

export interface PreferencesChanges {
  appearance?: Appearance;
  onboardingDismissed?: boolean;
  typography?: Partial<TypographySettings>;
  explorer?: Partial<ExplorerPreferences>;
  savedSearches?: SavedSearch[];
}

export function mergePreferenceChanges(current: PreferencesChanges, changes: PreferencesChanges): PreferencesChanges {
  return {
    ...current, ...changes,
    ...(changes.typography && { typography: { ...current.typography, ...changes.typography } }),
    ...(changes.explorer && { explorer: { ...current.explorer, ...changes.explorer } })
  };
}

export function mergePreferences(current: AppPreferences, changes: PreferencesChanges): AppPreferences {
  return {
    ...current, ...changes,
    typography: { ...current.typography, ...changes.typography },
    explorer: { ...current.explorer, ...changes.explorer }
  };
}

export const DefaultPreferences: AppPreferences = {
  appearance: "system",
  onboardingDismissed: false,
  savedSearches: [],
  typography: { ...DefaultTypography },
  explorer: {
    wrap: true, pageSize: PageSize, fields: false, inspector: false, timeline: false,
    columnOrder: DefaultColumnOrder, columnVisibility: DefaultColumnVisibility, columnSizing: {}
  }
};

export function urlAppearance(): Appearance | undefined {
  const value = new URLSearchParams(location.search).get("clawpilotTheme");
  return AppearanceChoices.find(choice => choice === value);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The server returned invalid app settings.");
  return value as Record<string, unknown>;
}

export function readPreferences(value: unknown): AppPreferences {
  const data = object(value);
  const appearance = AppearanceChoices.find(choice => choice === data.appearance);
  const typography = validateTypography(data.typography);
  const rawTypography = object(data.typography);
  const explorer = object(data.explorer);
  const visibility = object(explorer.columnVisibility);
  const sizing = object(explorer.columnSizing);
  const order = explorer.columnOrder;
  const rawSearches = data.savedSearches === undefined ? [] : data.savedSearches;
  if (!Array.isArray(rawSearches) || rawSearches.length > MaximumSavedSearches) throw new Error("The server returned invalid saved searches.");
  const names = new Set<string>();
  const savedSearches = rawSearches.map(value => {
    const search = object(value);
    const name = search.name;
    if (typeof name !== "string" || !name || name !== name.trim() || name.length > 64 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(name) || names.has(name.toLowerCase())) throw new Error("The server returned invalid saved searches.");
    names.add(name.toLowerCase());
    return { name, filters: readSessionFilters(search.filters) };
  });
  if (!appearance || (data.onboardingDismissed !== undefined && typeof data.onboardingDismissed !== "boolean") ||
    Object.entries(typography).some(([key, value]) => rawTypography[key] !== value) ||
    ["wrap", "fields", "inspector", "timeline"].some(key => typeof explorer[key] !== "boolean") ||
    typeof explorer.pageSize !== "number" || !Number.isInteger(explorer.pageSize) || explorer.pageSize < 1 || explorer.pageSize > MaximumPageSize ||
    !Array.isArray(order) || order.length !== DefaultColumnOrder.length || new Set(order).size !== order.length ||
    order.some(column => !DefaultColumnOrder.includes(column)) ||
    Object.entries(visibility).some(([key, value]) => !DefaultColumnOrder.includes(key) || typeof value !== "boolean" || (key === "message" && !value)) ||
    Object.entries(sizing).some(([key, value]) => !DefaultColumnOrder.includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 44 || value > 4000))
    throw new Error("The server returned invalid app settings.");
  return {
    appearance, typography, savedSearches, onboardingDismissed: data.onboardingDismissed === true,
    explorer: {
      wrap: explorer.wrap as boolean, pageSize: explorer.pageSize,
      fields: explorer.fields as boolean, inspector: explorer.inspector as boolean, timeline: explorer.timeline as boolean,
      columnOrder: order, columnVisibility: visibility as Record<string, boolean>, columnSizing: sizing as Record<string, number>
    }
  };
}
