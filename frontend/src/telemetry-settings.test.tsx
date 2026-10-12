import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TelemetrySourcesDialog } from "./TelemetrySourcesDialog";
import { TelemetryWorkspace } from "./TelemetryWorkspace";
import { fetchTelemetrySettings, readTelemetrySettings, saveTelemetrySettings, validateSourcePatterns, type TelemetrySettings } from "./telemetry-api";

const settings: TelemetrySettings = { meterSources: "App.*,System?", activitySources: "App.*", canConfigure: true };
const snapshot = { enabled: true, metrics: [], spans: [], droppedMetrics: 0, droppedSpans: 0 };
vi.mock("./telemetry-suggestions-api", async importOriginal => ({
  ...await importOriginal<typeof import("./telemetry-suggestions-api")>(),
  fetchDiscoveredTelemetrySources: vi.fn().mockResolvedValue({
    meterSources: [], activitySources: [], omittedMeterSources: 0, omittedActivitySources: 0
  })
}));
function response(value: unknown = settings, status = 200) { return new Response(JSON.stringify(value), { status }); }
function input(label = "Meter source patterns") { return screen.getByRole("textbox", { name: label }) as HTMLInputElement; }
function applyButton() { return screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement; }
async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Configure sources" }));
  await screen.findByRole("textbox", { name: "Meter source patterns" });
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe("telemetry settings API", () => {
  it("loads the relative route with abort support", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await fetchTelemetrySettings(signal)).toEqual(settings);
    expect(fetch).toHaveBeenCalledWith("api/telemetry/settings", { signal });
  });

  it("sends only explicit source patterns with the action header and reads authoritative settings", async () => {
    const authoritative = { ...settings, meterSources: "Normalized", canConfigure: false };
    const fetch = vi.fn().mockResolvedValue(response(authoritative));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await saveTelemetrySettings(settings, signal)).toEqual(authoritative);
    expect(fetch).toHaveBeenCalledWith("api/telemetry/settings", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "X-Log-Studio-Action": "telemetry-configure" },
      body: JSON.stringify({ meterSources: settings.meterSources, activitySources: settings.activitySources })
    });
  });

  it("accepts empty, case-sensitive wildcard patterns and exact field limits", () => {
    expect(validateSourcePatterns({ meterSources: "", activitySources: "" })).toBeNull();
    expect(validateSourcePatterns({ meterSources: "A.*,a?", activitySources: "x".repeat(4096) })).toBeNull();
    expect(validateSourcePatterns({ meterSources: Array(64).fill("*").join(","), activitySources: "" })).toBeNull();
    expect(readTelemetrySettings({ ...settings, canConfigure: false })).toEqual({ ...settings, canConfigure: false });
  });

  it.each(["meterSources", "activitySources"] as const)("rejects oversized %s and too many parts before sending", async field => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const value of ["x".repeat(4097), Array(65).fill("*").join(","), ",".repeat(64)]) {
      const invalid = { ...settings, [field]: value };
      expect(validateSourcePatterns(invalid)).not.toBeNull();
      expect(() => readTelemetrySettings(invalid)).toThrow(/invalid telemetry settings/);
      await expect(saveTelemetrySettings(invalid, new AbortController().signal)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { ...settings, canConfigure: "true" }, { ...settings, meterSources: 42 },
    { ...settings, activitySources: null }])("rejects invalid settings %j", value => {
    expect(() => readTelemetrySettings(value)).toThrow();
  });

  it("reports GET and POST errors instead of treating them as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 409)));
    await expect(fetchTelemetrySettings(new AbortController().signal)).rejects.toThrow("HTTP 409");
    await expect(saveTelemetrySettings(settings, new AbortController().signal)).rejects.toThrow("HTTP 409");
  });
});

describe("source configuration modal", () => {
  it("loads on demand, edits a draft, and applies once using the authoritative response", async () => {
    let finish!: (value: Response) => void;
    const authoritative = { ...settings, meterSources: "Authoritative", activitySources: "" };
    const fetch = vi.fn().mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response(authoritative));
    vi.stubGlobal("fetch", fetch);
    render(<TelemetrySourcesDialog />);
    expect(fetch).not.toHaveBeenCalled();
    await openDialog();
    expect(input().value).toBe(settings.meterSources);
    expect(input("Activity source patterns").value).toBe(settings.activitySources);
    fireEvent.change(input(), { target: { value: "New.*,Exact?" } });
    fireEvent.change(input("Activity source patterns"), { target: { value: "" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(applyButton());
    fireEvent.click(screen.getByRole("button", { name: "Applying…" }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ meterSources: "New.*,Exact?", activitySources: "" });
    expect(screen.queryByText(/Source patterns applied/)).toBeNull();
    finish(response(authoritative));
    await screen.findByText(/Source patterns applied to native capture/);
    expect(input().value).toBe("Authoritative");
    expect(input("Activity source patterns").value).toBe("");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByText(/Closing afterward does not undo applied changes/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await openDialog();
    expect(input().value).toBe("Authoritative");
    expect(input("Activity source patterns").value).toBe("");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it.each(["Cancel", "Escape"])("discards drafts on %s, aborts, and restores trigger focus", async close => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response()));
    vi.stubGlobal("fetch", fetch);
    render(<TelemetrySourcesDialog />);
    const trigger = screen.getByRole("button", { name: "Configure sources" });
    trigger.focus();
    await openDialog();
    fireEvent.change(input(), { target: { value: "Unsaved" } });
    if (close === "Cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
    await openDialog();
    expect(input().value).toBe(settings.meterSources);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps both drafts after a failed POST and permits an explicit retry", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response({}, 409)).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetch);
    render(<TelemetrySourcesDialog />);
    await openDialog();
    fireEvent.change(input(), { target: { value: "Draft.Meter" } });
    fireEvent.change(input("Activity source patterns"), { target: { value: "Draft.Activity" } });
    fireEvent.click(applyButton());
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 409");
    expect(input().value).toBe("Draft.Meter");
    expect(input("Activity source patterns").value).toBe("Draft.Activity");
    expect(screen.queryByText(/Source patterns applied/)).toBeNull();
    fireEvent.click(applyButton());
    await screen.findByText(/Source patterns applied to native capture/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not claim success for a malformed POST response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ ok: true })));
    render(<TelemetrySourcesDialog />);
    await openDialog();
    fireEvent.change(input(), { target: { value: "Draft" } });
    fireEvent.click(applyButton());
    await screen.findByRole("alert");
    expect(input().value).toBe("Draft");
    expect(screen.queryByText(/Source patterns applied/)).toBeNull();
  });

  it("shows loading and GET errors with a retry, without enabling mutation", async () => {
    let fail!: (reason: Error) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise<Response>((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce(response()));
    render(<TelemetrySourcesDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Configure sources" }));
    expect(screen.getByText("Loading source configuration…")).toBeDefined();
    expect(applyButton().disabled).toBe(true);
    fail(new Error("Offline"));
    await screen.findByRole("alert");
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    await screen.findByRole("textbox", { name: "Meter source patterns" });
    expect(applyButton().disabled).toBe(false);
  });

  it("explains startup opt-in for disabled or completed capture and prevents mutation", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ...settings, canConfigure: false }));
    vi.stubGlobal("fetch", fetch);
    render(<TelemetrySourcesDialog />);
    await openDialog();
    expect(input().disabled).toBe(true);
    expect(input("Activity source patterns").disabled).toBe(true);
    expect(applyButton().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("LOG_STUDIO_TELEMETRY=true at startup");
    fireEvent.click(applyButton());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds draft fields and rejects more than 64 raw comma-delimited parts", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    render(<TelemetrySourcesDialog />);
    await openDialog();
    expect(input().maxLength).toBe(4096);
    expect(input("Activity source patterns").maxLength).toBe(4096);
    fireEvent.change(input(), { target: { value: ",".repeat(64) } });
    expect(screen.getByRole("alert").textContent).toContain("64 comma-delimited parts");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts pending saves on close and ignores late responses after reopening", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetch);
    render(<TelemetrySourcesDialog />);
    await openDialog();
    fireEvent.click(applyButton());
    const signal = fetch.mock.calls[1]![1].signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal.aborted).toBe(true);
    await openDialog();
    finish(response({ ...settings, meterSources: "Stale" }));
    await flush();
    expect(input().value).toBe(settings.meterSources);
    expect(screen.queryByText(/Source patterns applied/)).toBeNull();
  });
});

describe("source configuration workspace lifecycle", () => {
  it.each(["metrics", "traces"] as const)("offers configuration on %s, but never requests it in archives", async view => {
    const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith("/settings") ? settings : snapshot)));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<TelemetryWorkspace view={view} archived />);
    expect(screen.queryByRole("button", { name: "Configure sources" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    rerender(<TelemetryWorkspace view={view} archived={false} />);
    await openDialog();
    const settingsCall = fetch.mock.calls.find(call => call[0].endsWith("/settings"))!;
    rerender(<TelemetryWorkspace view={view} archived />);
    expect((settingsCall[1].signal as AbortSignal).aborted).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByDisplayValue(settings.meterSources)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["traces", "archive", "unmount"])("aborts a pending save on transition to %s and hides drafts", async transition => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === "POST") return new Promise<Response>(resolve => { finish = resolve; });
      return Promise.resolve(response(url.endsWith("/settings") ? settings : snapshot));
    });
    vi.stubGlobal("fetch", fetch);
    const { rerender, unmount } = render(<TelemetryWorkspace view="metrics" archived={false} />);
    await openDialog();
    fireEvent.change(input(), { target: { value: "Unsaved" } });
    fireEvent.click(applyButton());
    const save = fetch.mock.calls.find(call => call[1]?.method === "POST")!;
    if (transition === "unmount") unmount();
    else rerender(<TelemetryWorkspace view={transition === "traces" ? "traces" : "metrics"} archived={transition === "archive"} />);
    expect((save[1]!.signal as AbortSignal).aborted).toBe(true);
    finish(response({ ...settings, meterSources: "Stale" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByDisplayValue("Unsaved")).toBeNull();
    expect(screen.queryByText(/Source patterns applied/)).toBeNull();
    if (transition === "traces") {
      await openDialog();
      expect(input().value).toBe(settings.meterSources);
    }
  });
});
