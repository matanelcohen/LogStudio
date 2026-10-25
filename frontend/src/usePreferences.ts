import { useCallback, useEffect, useRef, useState } from "react";
import { appSettings } from "./api";
import { errorMessage } from "./model";
import { DefaultPreferences, mergePreferenceChanges, mergePreferences, TypographyStorageKey, urlAppearance, validateTypography, type AppPreferences, type PreferencesChanges } from "./preferences";

export function usePreferences() {
  const [override] = useState(urlAppearance);
  const [settings, setSettings] = useState<AppPreferences>(() => ({ ...DefaultPreferences, appearance: override ?? DefaultPreferences.appearance }));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<PreferencesChanges>(override ? { appearance: override } : {});
  const loaded = useRef(false);
  const writing = useRef(false);
  const mounted = useRef(false);

  const flush = useCallback(async function flush() {
    if (!loaded.current || writing.current || !Object.keys(pending.current).length) return;
    writing.current = true;
    setSaved(false);
    while (Object.keys(pending.current).length) {
      const changes = pending.current;
      pending.current = {};
      try {
        await appSettings(changes);
      } catch (error) {
        pending.current = mergePreferenceChanges(changes, pending.current);
        writing.current = false;
        if (mounted.current) setError(`Could not autosave settings: ${errorMessage(error)}`);
        return;
      }
    }
    writing.current = false;
    if (mounted.current) { setSaved(true); setError(null); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function restore() {
      try {
        const result = await appSettings(undefined, controller.signal);
        if (!active) return;
        const migration: PreferencesChanges = {};
        if (!result.hasPreferences) {
          try {
            const legacy = localStorage.getItem(TypographyStorageKey);
            if (legacy !== null) migration.typography = validateTypography(JSON.parse(legacy));
          } catch (error) {
            console.warn("Could not migrate browser typography settings", error);
          }
        }
        pending.current = mergePreferenceChanges(migration, pending.current);
        setSettings(mergePreferences(result.preferences, pending.current));
        loaded.current = true;
        setError(null);
        setSaved(!Object.keys(pending.current).length);
        void flush();
      } catch (error) {
        if (active) setError(`Could not restore app settings: ${errorMessage(error)}`);
      }
    }
    void restore();
    return () => { active = false; controller.abort(); };
  }, [attempt, flush]);

  const update = useCallback((changes: PreferencesChanges) => {
    setSettings(current => mergePreferences(current, changes));
    pending.current = mergePreferenceChanges(pending.current, changes);
    setSaved(false);
    void flush();
  }, [flush]);

  return {
    settings, saved, error, update,
    retry: () => { if (loaded.current) void flush(); else setAttempt(value => value + 1); }
  };
}
