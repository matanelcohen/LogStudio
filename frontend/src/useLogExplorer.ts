import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPage, readStatus } from "./api";
import {
  ApiRoutes, buildQueryParameters, errorMessage, LiveStatusEvent, QueryDelayMs,
  type ConnectionState, type LogPage, type PageCursor, type QueryState, type ViewerStatus
} from "./model";

export function useLiveStatus(paused: boolean) {
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const latest = useRef<ViewerStatus | null>(null);
  const resumeThrough = useRef<number | null>(null);
  const [gap, setGap] = useState<string | null>(null);

  useEffect(() => {
    if (paused) {
      resumeThrough.current = latest.current?.lastId ?? 0;
      setConnection("paused");
    } else {
      setConnection("connecting");
    }
    setError(null);
    const source = new EventSource(ApiRoutes.Updates);
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onopen = () => setConnection(paused ? "paused" : "live");
    source.onerror = () => {
      resumeThrough.current ??= latest.current?.lastId ?? 0;
      setConnection(paused ? "paused" : "reconnecting");
    };
    source.addEventListener(LiveStatusEvent, (event: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(event.data);
        const next = readStatus(value);
        if (latest.current && next.revision < latest.current.revision) return;
        const cleared = next.clearedThroughId > (latest.current?.clearedThroughId ?? 0);
        if (paused && !cleared) {
          if (latest.current) {
            latest.current = { ...latest.current, applicationName: next.applicationName, canWriteInput: next.canWriteInput, revision: next.revision };
          }
          setStatus(status => status === null ? next : status.applicationName === next.applicationName && status.canWriteInput === next.canWriteInput ? status :
            { ...status, applicationName: next.applicationName, canWriteInput: next.canWriteInput, revision: next.revision });
          return;
        }
        if (!cleared && resumeThrough.current !== null && next.firstId > resumeThrough.current + 1)
          setGap("Some entries expired under the explicit retention limit while this tab was disconnected.");
        resumeThrough.current = null;
        latest.current = next;
        if (timer === null) {
          timer = setTimeout(() => {
            timer = null;
            setStatus(latest.current);
          }, QueryDelayMs);
        }
      } catch (error) {
        source.close();
        setConnection("failed");
        setError(`Could not read live updates: ${errorMessage(error)}`);
      }
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      source.close();
    };
  }, [paused, retry]);

  const reconnect = useCallback(() => setRetry(value => value + 1), []);
  const applyStatus = useCallback((next: ViewerStatus) => {
    if (latest.current && next.revision < latest.current.revision) return;
    latest.current = next;
    setStatus(next);
  }, []);
  return { status, connection, error, gap, reconnect, applyStatus };
}

export function useLogPage(query: QueryState, cursor: PageCursor, maximumId: number | null, revision: number, paused: boolean, clearedThroughId = 0) {
  const key = JSON.stringify({ query, cursor, maximumId, clearedThroughId });
  const [response, setResponse] = useState<{ key: string; page: LogPage | null; error: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const refreshRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    setLoading(true);

    async function run() {
      timer = null;
      inFlight = true;
      requested = false;
      controller = new AbortController();
      setLoading(true);
      try {
        const result = await fetchPage(buildQueryParameters(query, cursor, maximumId), controller.signal);
        if (!active) return;
        if (result.status.clearedThroughId < clearedThroughId) throw new Error("Session history changed during the request. Refresh the current history.");
        setResponse({ key, page: result, error: null });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setResponse({ key, page: null, error: errorMessage(error) });
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          if (requested) schedule();
        }
      }
    }

    function schedule() {
      requested = true;
      if (!inFlight && timer === null) timer = setTimeout(run, QueryDelayMs);
    }

    refreshRef.current = schedule;
    schedule();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      refreshRef.current = () => undefined;
    };
  }, [query, cursor, maximumId, key, retry]);

  useEffect(() => refreshRef.current(), [revision]);
  useEffect(() => {
    if (paused || query.timeWindow === 0) return;
    const timer = setInterval(() => refreshRef.current(), 1000);
    return () => clearInterval(timer);
  }, [paused, query.timeWindow]);
  useEffect(() => {
    if (!query.sessionId) return;
    const timer = setInterval(() => refreshRef.current(), 2000);
    return () => clearInterval(timer);
  }, [query.sessionId]);
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  const current = response?.key === key ? response : null;
  return { page: current?.page ?? null, loading: loading || current === null, error: current?.error ?? null, refresh };
}
