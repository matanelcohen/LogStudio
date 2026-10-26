import { describe, expect, it, vi } from "vitest";
import { appSettings } from "./api";
import { DefaultPreferences, readPreferences } from "./preferences";
import { defaultQuery, sessionFilters } from "./model";
import { DefaultGraph } from "./analytics-model";

describe("preferences API", () => {
  it("defaults legacy onboarding settings and validates persisted dismissal", () => {
    const { onboardingDismissed: _, ...legacy } = DefaultPreferences;
    expect(readPreferences(legacy).onboardingDismissed).toBe(false);
    expect(readPreferences({ ...legacy, onboardingDismissed: true }).onboardingDismissed).toBe(true);
    const savedGraphs = [{ graph: DefaultGraph, filters: sessionFilters(defaultQuery()) }];
    const restored = readPreferences({ ...legacy, onboardingDismissed: true, savedGraphs });
    expect(restored.onboardingDismissed).toBe(true);
    expect(restored.savedGraphs).toEqual(savedGraphs);
    expect(() => readPreferences({ ...legacy, onboardingDismissed: "true" })).toThrow("invalid app settings");
  });
  it("reads reusable saved searches and migrates preferences without presets", () => {
    const filters = sessionFilters({ ...defaultQuery(), search: "error", since: "2026-10-11T18:00:00Z" });
    const searches = [{ name: "Errors", filters }];
    expect(readPreferences({ ...DefaultPreferences, savedSearches: searches }).savedSearches).toEqual(searches);
    const { savedSearches: _, ...legacy } = DefaultPreferences;
    expect(readPreferences(legacy).savedSearches).toEqual([]);
    expect(() => readPreferences({ ...DefaultPreferences, savedSearches: [...searches, { name: "errors", filters }] })).toThrow();
    expect(() => readPreferences({ ...DefaultPreferences, savedSearches: [{ name: "Bad", filters: { ...filters, until: "invalid" } }] })).toThrow();
  });
  it("reads settings and saves only changed fields with the explicit action and keepalive", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ preferences: DefaultPreferences, hasPreferences: true }) });
    vi.stubGlobal("fetch", fetch);
    expect((await appSettings()).preferences).toEqual(DefaultPreferences);
    await appSettings({ typography: { logFontSize: 20 } });
    expect(fetch).toHaveBeenLastCalledWith("api/settings", {
      method: "POST", headers: { "X-Log-Studio-Action": "save-settings", "Content-Type": "application/json" },
      body: '{"typography":{"logFontSize":20}}', keepalive: true
    });
  });

  it("surfaces server errors instead of reporting a successful save", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "Cannot write settings" }) }));
    await expect(appSettings({ appearance: "dark" })).rejects.toThrow("Cannot write settings");
  });

  it.each([
    { ...DefaultPreferences, appearance: "unsupported" },
    { ...DefaultPreferences, typography: { ...DefaultPreferences.typography, logFontSize: 25 } },
    { ...DefaultPreferences, explorer: { ...DefaultPreferences.explorer, pageSize: 0 } },
    { ...DefaultPreferences, explorer: { ...DefaultPreferences.explorer, wrap: "true" } },
    { ...DefaultPreferences, explorer: { ...DefaultPreferences.explorer, columnOrder: ["message"] } },
    { ...DefaultPreferences, explorer: { ...DefaultPreferences.explorer, columnVisibility: { message: false } } },
    { ...DefaultPreferences, explorer: { ...DefaultPreferences.explorer, columnSizing: { category: Infinity } } }
  ])("rejects invalid settings returned by the server: %j", value => {
    expect(() => readPreferences(value)).toThrow("invalid app settings");
  });
});
