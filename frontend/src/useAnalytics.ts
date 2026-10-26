import { useEffect, useRef, useState } from "react";
import { fetchAnalytics } from "./analytics-api";
import type { AnalyticsSnapshot } from "./analytics-model";
import { buildQueryParameters, errorMessage, type QueryState } from "./model";

export function useAnalytics(query: QueryState, maximumId: number | null, paused: boolean, historyDirectory: string, clearedThroughId: number) {
  const key = JSON.stringify({ query: { ...query, pageSize: 0 }, maximumId, historyDirectory, clearedThroughId });
  const [response, setResponse] = useState<{ key: string; snapshot: AnalyticsSnapshot; parameters: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      setLoading(true);
      try {
        const parameters = buildQueryParameters(query, { before: null, after: null }, maximumId);
        parameters.delete("pageSize");
        const snapshot = await fetchAnalytics(parameters, controller.signal);
        if (id !== request.current || controller.signal.aborted) return;
        if (historyDirectory && snapshot.status.historyDirectory !== historyDirectory)
          throw new Error("The selected application changed. Refresh the current history.");
        if (snapshot.status.clearedThroughId < clearedThroughId)
          throw new Error("Session history changed. Refresh the current history.");
        parameters.set("maxId", String(Math.min(maximumId ?? snapshot.status.lastId, snapshot.status.lastId)));
        setResponse({ key, snapshot, parameters: parameters.toString() }); setError(null);
      } catch (error) {
        if (!controller.signal.aborted && id === request.current) setError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted && id === request.current) {
          setLoading(false);
          if (!paused) timer = setTimeout(refresh, 5000);
        }
      }
    }
    setError(null);
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, attempt, paused]);
  const current = response?.key === key ? response : null;
  return { snapshot: current?.snapshot ?? null, parameters: current?.parameters ?? "", loading, error, refresh: () => setAttempt(value => value + 1) };
}
