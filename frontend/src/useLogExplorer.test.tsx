import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryDelayMs, defaultQuery } from "./model";
import { Entry, fixturePage } from "./test-fixtures";
import { Status } from "./test-fixtures";
import { useLiveStatus, useLogPage } from "./useLogExplorer";

const Cursor = { before: null, after: null };

class EventSourceFixture {
  static instances: EventSourceFixture[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  private listener: ((event: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) {
    EventSourceFixture.instances.push(this);
  }
  addEventListener(_name: string, listener: (event: MessageEvent<string>) => void) {
    this.listener = listener;
  }
  emit(value: unknown) {
    this.listener?.(new MessageEvent("status", { data: JSON.stringify(value) }));
  }
}

describe("bounded single-page requests", () => {
  it("coalesces live updates without concurrent requests or retained old pages", async () => {
    vi.useFakeTimers();
    let resolve: ((response: Response) => void) | undefined;
    const request = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", request);
    const query = defaultQuery();
    const hook = renderHook(({ revision }) => useLogPage(query, Cursor, null, revision, false), { initialProps: { revision: 1 } });
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    expect(request).toHaveBeenCalledTimes(1);
    hook.rerender({ revision: 2 });
    hook.rerender({ revision: 3 });
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs * 2));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { resolve?.(new Response(JSON.stringify(fixturePage()))); });
    expect(hook.result.current.page?.entries).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    expect(request).toHaveBeenCalledTimes(2);
    const next = { ...Entry, id: 2, message: "next page" };
    await act(async () => { resolve?.(new Response(JSON.stringify(fixturePage(next)))); });
    expect(hook.result.current.page?.entries).toEqual([next]);
  });

  describe("metadata-only live updates", () => {
    it("updates terminal input availability while paused without unfreezing logs", async () => {
      vi.useFakeTimers();
      EventSourceFixture.instances = [];
      vi.stubGlobal("EventSource", EventSourceFixture);
      const hook = renderHook(({ paused }) => useLiveStatus(paused), { initialProps: { paused: false } });
      const running = { ...Status, isCompleted: false, completedAt: null, exitCode: null, canWriteInput: true };
      act(() => EventSourceFixture.instances[0]?.emit(running));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.canWriteInput).toBe(true);
      hook.rerender({ paused: true });
      act(() => EventSourceFixture.instances[1]?.emit({
        ...running, canWriteInput: false, lastId: 30000, revision: 30001
      }));
      expect(hook.result.current.status?.canWriteInput).toBe(false);
      expect(hook.result.current.status?.lastId).toBe(Status.lastId);
      act(() => EventSourceFixture.instances[1]?.emit({ ...running, revision: 30000 }));
      expect(hook.result.current.status?.canWriteInput).toBe(false);
    });

    it("freezes updates while paused and reconnects without storing log history", async () => {
      vi.useFakeTimers();
      EventSourceFixture.instances = [];
      vi.stubGlobal("EventSource", EventSourceFixture);
      const hook = renderHook(({ paused }) => useLiveStatus(paused), { initialProps: { paused: false } });
      const first = EventSourceFixture.instances[0];
      if (!first) throw new Error("The fixture event source was not created.");
      expect(first.url).toBe("api/updates");
      act(() => { first.onopen?.(); first.emit(Status); });
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.connection).toBe("live");
      expect(hook.result.current.status?.lastId).toBe(20000);
      hook.rerender({ paused: true });
      expect(first.close).toHaveBeenCalled();
      expect(hook.result.current.connection).toBe("paused");
      const pausedSource = EventSourceFixture.instances[1];
      if (!pausedSource) throw new Error("The paused metadata channel was not created.");
      act(() => pausedSource.emit({ ...Status, lastId: 30000, revision: 30001 }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.lastId).toBe(20000);
      hook.rerender({ paused: false });
      const resumed = EventSourceFixture.instances[2];
      if (!resumed) throw new Error("The resumed event source was not created.");
      act(() => resumed.emit({ ...Status, lastId: 40000, firstId: 21000, revision: 40001 }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.lastId).toBe(40000);
      expect(hook.result.current.gap).toContain("expired");
    });

    it("invalidates cached history on a session-wide clear even while paused", async () => {
      vi.useFakeTimers();
      EventSourceFixture.instances = [];
      vi.stubGlobal("EventSource", EventSourceFixture);
      const hook = renderHook(({ paused }) => useLiveStatus(paused), { initialProps: { paused: false } });
      act(() => EventSourceFixture.instances[0]?.emit(Status));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      hook.rerender({ paused: true });
      act(() => EventSourceFixture.instances[1]?.emit({ ...Status, retainedCount: 0, firstId: 0, clearedThroughId: 20000, revision: 20002 }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.clearedThroughId).toBe(20000);
      expect(hook.result.current.status?.retainedCount).toBe(0);
    });

    it("loads another app's history while paused without treating its IDs as expired entries", async () => {
      vi.useFakeTimers();
      EventSourceFixture.instances = [];
      vi.stubGlobal("EventSource", EventSourceFixture);
      const hook = renderHook(({ paused }) => useLiveStatus(paused), { initialProps: { paused: false } });
      act(() => EventSourceFixture.instances[0]?.emit({ ...Status, listenAll: true, lastId: 1 }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      hook.rerender({ paused: true });
      const switched = {
        ...Status, listenAll: true, historyDirectory: "/private/temp/another-app",
        firstId: 100, lastId: 150, revision: Status.revision + 1
      };
      act(() => EventSourceFixture.instances[1]?.emit(switched));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status).toMatchObject(switched);
      expect(hook.result.current.gap).toBeNull();
      act(() => EventSourceFixture.instances[1]?.emit({ ...Status, listenAll: true }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.historyDirectory).toBe(switched.historyDirectory);
      act(() => EventSourceFixture.instances[1]?.emit({
        ...Status, listenAll: true, firstId: 1, lastId: 1, revision: switched.revision + 1
      }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.historyDirectory).toBe(Status.historyDirectory);
      expect(hook.result.current.status?.lastId).toBe(1);
      expect(hook.result.current.gap).toBeNull();
    });

    it("applies ordered name updates while paused without changing the log snapshot", async () => {
      vi.useFakeTimers();
      EventSourceFixture.instances = [];
      vi.stubGlobal("EventSource", EventSourceFixture);
      const hook = renderHook(({ paused }) => useLiveStatus(paused), { initialProps: { paused: false } });
      act(() => EventSourceFixture.instances[0]?.emit(Status));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      hook.rerender({ paused: true });
      act(() => EventSourceFixture.instances[1]?.emit({ ...Status, applicationName: "Newer investigation", lastId: 30000, revision: 30001 }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.lastId).toBe(Status.lastId);
      expect(hook.result.current.status?.applicationName).toBe("Newer investigation");
      act(() => EventSourceFixture.instances[1]?.emit({ ...Status, applicationName: "Obsolete investigation", revision: 30000 }));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.applicationName).toBe("Newer investigation");
      expect(hook.result.current.status?.lastId).toBe(Status.lastId);
    });

    it("publishes a debounced rename after pausing even when it already matches the latest metadata", async () => {
      vi.useFakeTimers();
      EventSourceFixture.instances = [];
      vi.stubGlobal("EventSource", EventSourceFixture);
      const hook = renderHook(({ paused }) => useLiveStatus(paused), { initialProps: { paused: false } });
      act(() => EventSourceFixture.instances[0]?.emit(Status));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      const renamed = { ...Status, applicationName: "Latest investigation", lastId: Status.lastId + 1, revision: Status.revision + 2 };
      act(() => EventSourceFixture.instances[0]?.emit(renamed));
      hook.rerender({ paused: true });
      act(() => EventSourceFixture.instances[1]?.emit(renamed));
      await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
      expect(hook.result.current.status?.applicationName).toBe(renamed.applicationName);
      expect(hook.result.current.status?.lastId).toBe(Status.lastId);
      expect(hook.result.current.status?.retainedCount).toBe(Status.retainedCount);
    });

    it("reports invalid live payloads instead of applying silent defaults", () => {
      EventSourceFixture.instances = [];
      vi.stubGlobal("EventSource", EventSourceFixture);
      const hook = renderHook(() => useLiveStatus(false));
      const source = EventSourceFixture.instances[0];
      if (!source) throw new Error("The fixture event source was not created.");
      act(() => source.emit({ invalid: true }));
      expect(hook.result.current.connection).toBe("failed");
      expect(hook.result.current.error).toContain("Could not read live updates");
      expect(source.close).toHaveBeenCalled();
    });
  });

  it("rejects stale in-flight results after a preference change", async () => {
    vi.useFakeTimers();
    const resolvers: ((response: Response) => void)[] = [];
    const request = vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve)));
    vi.stubGlobal("fetch", request);
    const hook = renderHook(({ query }) => useLogPage(query, Cursor, null, 1, false), { initialProps: { query: defaultQuery() } });
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    hook.rerender({ query: { ...defaultQuery(), search: "new" } });
    expect(hook.result.current.page).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    await act(async () => { resolvers[0]?.(new Response(JSON.stringify(fixturePage()))); });
    expect(hook.result.current.page).toBeNull();
    const entry = { ...Entry, message: "new result" };
    await act(async () => { resolvers[1]?.(new Response(JSON.stringify(fixturePage(entry)))); });
    expect(hook.result.current.page?.entries[0]?.message).toBe("new result");
  });

  it("invalidates an in-flight old page when session history is cleared", async () => {
    vi.useFakeTimers();
    const resolvers: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve))));
    const query = defaultQuery();
    const hook = renderHook(({ cleared }) => useLogPage(query, Cursor, null, 1, false, cleared), { initialProps: { cleared: 0 } });
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    hook.rerender({ cleared: 20000 });
    expect(hook.result.current.page).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    await act(async () => resolvers[0]?.(new Response(JSON.stringify(fixturePage()))));
    expect(hook.result.current.page).toBeNull();
    const current = {
      ...fixturePage(), entries: [], matchCount: 0,
      status: { ...Status, retainedCount: 0, firstId: 0, clearedThroughId: 20000, revision: 20002 }
    };
    await act(async () => resolvers[1]?.(new Response(JSON.stringify(current))));
    expect(hook.result.current.page?.entries).toEqual([]);
    expect(hook.result.current.page?.status.clearedThroughId).toBe(20000);
  });

  it("discards the previous app's page and in-flight response when switching histories", async () => {
    vi.useFakeTimers();
    const resolvers: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve))));
    const query = defaultQuery();
    const otherDirectory = "/private/temp/another-app";
    const hook = renderHook(({ directory }) => useLogPage(query, Cursor, null, 1, false, 0, directory), {
      initialProps: { directory: Status.historyDirectory }
    });
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    await act(async () => resolvers[0]?.(new Response(JSON.stringify(fixturePage()))));
    expect(hook.result.current.page?.entries).toEqual([Entry]);
    act(() => hook.result.current.refresh());
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    hook.rerender({ directory: otherDirectory });
    expect(hook.result.current.page).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    await act(async () => resolvers[1]?.(new Response(JSON.stringify(fixturePage()))));
    expect(hook.result.current.page).toBeNull();
    const current = { ...fixturePage(), status: { ...Status, historyDirectory: otherDirectory } };
    await act(async () => resolvers[2]?.(new Response(JSON.stringify(current))));
    expect(hook.result.current.page?.status.historyDirectory).toBe(otherDirectory);
  });

  it("rejects responses from a different app even when the clear checkpoint matches", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixturePage()))));
    const query = defaultQuery();
    const hook = renderHook(() => useLogPage(query, Cursor, null, 1, false, 0, "/private/temp/another-app"));
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    expect(hook.result.current.page).toBeNull();
    expect(hook.result.current.error).toContain("selected application changed");
  });

  it("surfaces query errors and clears them after a successful retry", async () => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Invalid regex condition" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixturePage())));
    vi.stubGlobal("fetch", request);
    const query = defaultQuery();
    const hook = renderHook(() => useLogPage(query, Cursor, null, 1, false));
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    expect(hook.result.current.error).toBe("Invalid regex condition");
    expect(hook.result.current.page).toBeNull();
    act(() => hook.result.current.refresh());
    await act(() => vi.advanceTimersByTimeAsync(QueryDelayMs));
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.page?.entries).toHaveLength(1);
  });
});
