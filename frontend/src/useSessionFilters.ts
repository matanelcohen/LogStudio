import { useEffect, useRef } from "react";
import { fetchSessions, readSessionFilters, saveSessionFilters } from "./api";
import { defaultQuery, sessionFilters, type QueryState, type SessionFilters, type SessionInfo } from "./model";

export function useSessionFilters(onRestore: (filters: SessionFilters) => void, onError: (error: unknown) => void) {
  const cache = useRef(new Map<string, SessionFilters>());
  const pending = useRef(new Map<string, SessionFilters>());
  const unsaved = useRef(new Map<string, SessionFilters>());
  const writing = useRef(false);
  const callbacks = useRef({ onRestore, onError });
  callbacks.current = { onRestore, onError };

  function storePending() {
    try {
      const key = `logstudio-filter-outbox:${window.location.pathname}`;
      if (unsaved.current.size) sessionStorage.setItem(key, JSON.stringify([...unsaved.current]));
      else sessionStorage.removeItem(key);
    } catch {
      // Server persistence still works when browser storage is unavailable.
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(`logstudio-filter-outbox:${window.location.pathname}`) ?? "[]");
      if (!Array.isArray(stored)) throw new Error("Invalid pending filters.");
      const restored = new Map<string, SessionFilters>();
      for (const entry of stored) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
          throw new Error("Invalid pending filters.");
        restored.set(entry[0], readSessionFilters(entry[1]));
      }
      for (const [id, filters] of restored) {
        cache.current.set(id, filters);
        pending.current.set(id, filters);
        unsaved.current.set(id, filters);
      }
      const current = restored.get("");
      if (current) callbacks.current.onRestore(current);
      void writePending();
    } catch {
      // Ignore unavailable storage or an obsolete outbox.
    }
    fetchSessions(controller.signal).then(sessions => {
      if (controller.signal.aborted || cache.current.has("")) return;
      const current = sessions.find(session => session.isCurrent);
      if (!current) return;
      const filters = current.filters ?? sessionFilters(defaultQuery());
      cache.current.set("", filters);
      callbacks.current.onRestore(filters);
    }).catch(error => {
      if (!controller.signal.aborted) callbacks.current.onError(error);
    });
    return () => controller.abort();
  }, []);

  async function writePending() {
    if (writing.current) return;
    writing.current = true;
    try {
      while (pending.current.size > 0) {
        const [id, filters] = pending.current.entries().next().value!;
        pending.current.delete(id);
        try {
          await saveSessionFilters(id, filters);
          if (unsaved.current.get(id) === filters) unsaved.current.delete(id);
          storePending();
        } catch (error) {
          callbacks.current.onError(error);
        }
      }
    } finally {
      writing.current = false;
    }
  }

  function save(query: QueryState, force = false) {
    const filters = sessionFilters(query);
    const previous = cache.current.get(query.sessionId) ?? sessionFilters(defaultQuery());
    if (!force && JSON.stringify(previous) === JSON.stringify(filters)) return;
    cache.current.set(query.sessionId, filters);
    pending.current.set(query.sessionId, filters);
    unsaved.current.set(query.sessionId, filters);
    storePending();
    void writePending();
  }

  function restore(session: Pick<SessionInfo, "id" | "isCurrent" | "filters">): SessionFilters {
    const id = session.isCurrent ? "" : session.id;
    const filters = cache.current.get(id) ?? session.filters ?? sessionFilters(defaultQuery());
    cache.current.set(id, filters);
    return filters;
  }

  return { save, restore };
}
