import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { defaultQuery, sessionFilters, type SessionInfo } from "./model";
import { useSessionFilters } from "./useSessionFilters";

const current: SessionInfo = {
  id: "current", name: "Current run", startedAt: "2026-10-11T08:00:00Z",
  completedAt: null, exitCode: null, entryCount: 2, command: null,
  arguments: [], workingDirectory: "", isCurrent: true
};

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(api, "fetchSessions").mockResolvedValue([]);
  vi.spyOn(api, "saveSessionFilters").mockResolvedValue();
});

describe("session filter persistence", () => {
  it("restores saved current filters without writing defaults back", async () => {
    const filters = sessionFilters({
      ...defaultQuery(), search: "Failure", matchCase: true, severity: "errorPlus",
      levels: ["error", "critical"], stream: "stderr", category: '"Example"', timeWindow: 300000,
      conditions: [{ mode: "exclude", field: "message", operator: "regex", value: "^heartbeat" }], includeMode: "any"
    });
    vi.mocked(api.fetchSessions).mockResolvedValue([{ ...current, filters }]);
    const restore = vi.fn();
    renderHook(() => useSessionFilters(restore, vi.fn()));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(filters));
    expect(api.saveSessionFilters).not.toHaveBeenCalled();
  });

  it("does not let a late restore overwrite edits made while loading", async () => {
    let finish!: (sessions: SessionInfo[]) => void;
    vi.mocked(api.fetchSessions).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const restore = vi.fn();
    const { result } = renderHook(() => useSessionFilters(restore, vi.fn()));
    act(() => result.current.save({ ...defaultQuery(), search: "New search" }));
    await act(async () => finish([{ ...current, filters: sessionFilters({ ...defaultQuery(), search: "Old search" }) }]));
    expect(restore).not.toHaveBeenCalled();
    expect(result.current.restore(current).search).toBe("New search");
  });

  it("persists an explicit reset even before the initial restore finishes", async () => {
    let finish!: (sessions: SessionInfo[]) => void;
    vi.mocked(api.fetchSessions).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const restore = vi.fn();
    const { result } = renderHook(() => useSessionFilters(restore, vi.fn()));
    act(() => result.current.save(defaultQuery(), true));
    await act(async () => finish([{ ...current, filters: sessionFilters({ ...defaultQuery(), search: "Old search" }) }]));
    expect(restore).not.toHaveBeenCalled();
    expect(api.saveSessionFilters).toHaveBeenCalledWith("", sessionFilters(defaultQuery()));
  });

  it("replays the latest unsent filters after reload instead of restoring a stale saved snapshot", async () => {
    let finish!: () => void;
    vi.mocked(api.saveSessionFilters).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = renderHook(() => useSessionFilters(vi.fn(), vi.fn()));
    act(() => {
      first.result.current.save({ ...defaultQuery(), search: "First" });
      first.result.current.save({ ...defaultQuery(), search: "Latest" });
    });
    first.unmount();
    vi.mocked(api.fetchSessions).mockResolvedValue([{ ...current, filters: sessionFilters({ ...defaultQuery(), search: "Stale" }) }]);
    const restore = vi.fn();
    renderHook(() => useSessionFilters(restore, vi.fn()));
    expect(restore).toHaveBeenCalledExactlyOnceWith(sessionFilters({ ...defaultQuery(), search: "Latest" }));
    await waitFor(() => expect(api.saveSessionFilters).toHaveBeenLastCalledWith("", sessionFilters({ ...defaultQuery(), search: "Latest" })));
    await waitFor(() => expect(sessionStorage.length).toBe(0));
    await act(async () => finish());
  });

  it("keeps server persistence available if browser storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Storage blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage blocked"); });
    const { result } = renderHook(() => useSessionFilters(vi.fn(), vi.fn()));
    act(() => result.current.save({ ...defaultQuery(), search: "New search" }));
    await waitFor(() => expect(api.saveSessionFilters).toHaveBeenCalledWith("", sessionFilters({ ...defaultQuery(), search: "New search" })));
  });

  it("ignores an initial response after unmount", async () => {
    let finish!: (sessions: SessionInfo[]) => void;
    vi.mocked(api.fetchSessions).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const restore = vi.fn();
    const { unmount } = renderHook(() => useSessionFilters(restore, vi.fn()));
    unmount();
    await act(async () => finish([current]));
    expect(restore).not.toHaveBeenCalled();
    expect(vi.mocked(api.fetchSessions).mock.calls[0]?.[0].aborted).toBe(true);
  });

  it("serializes writes, coalesces pending edits, and retains filters separately per session", async () => {
    let finish!: () => void;
    vi.mocked(api.saveSessionFilters).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useSessionFilters(vi.fn(), vi.fn()));
    act(() => {
      result.current.save({ ...defaultQuery(), search: "First" });
      result.current.save({ ...defaultQuery(), search: "Intermediate" });
      result.current.save({ ...defaultQuery(), search: "Latest", levels: [] });
      result.current.save({ ...defaultQuery(), search: "Saved search", sessionId: "saved" });
    });
    expect(api.saveSessionFilters).toHaveBeenCalledTimes(1);
    expect(result.current.restore(current).search).toBe("Latest");
    expect(result.current.restore({ ...current, isCurrent: false, id: "saved" }).search).toBe("Saved search");
    await act(async () => finish());
    expect(api.saveSessionFilters).toHaveBeenCalledTimes(3);
    expect(api.saveSessionFilters).toHaveBeenNthCalledWith(2, "", sessionFilters({ ...defaultQuery(), search: "Latest", levels: [] }));
    expect(api.saveSessionFilters).toHaveBeenNthCalledWith(3, "saved", sessionFilters({ ...defaultQuery(), search: "Saved search" }));
  });

  it("uses defaults for legacy sessions and never persists navigation or dismissal state", () => {
    const { result } = renderHook(() => useSessionFilters(vi.fn(), vi.fn()));
    expect(result.current.restore({ ...current, isCurrent: false })).toEqual(sessionFilters(defaultQuery()));
    act(() => result.current.save({ ...defaultQuery(), dismissedThrough: 99, pageSize: 1000 }));
    expect(api.saveSessionFilters).not.toHaveBeenCalled();
  });

  it("reports save and restore failures without preventing later writes", async () => {
    vi.mocked(api.fetchSessions).mockRejectedValue(new Error("Restore failed"));
    vi.mocked(api.saveSessionFilters).mockRejectedValueOnce(new Error("Save failed"));
    const error = vi.fn();
    const { result } = renderHook(() => useSessionFilters(vi.fn(), error));
    act(() => {
      result.current.save({ ...defaultQuery(), search: "First" });
      result.current.save({ ...defaultQuery(), search: "Latest" });
    });
    await waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    expect(api.saveSessionFilters).toHaveBeenLastCalledWith("", sessionFilters({ ...defaultQuery(), search: "Latest" }));
  });
});
