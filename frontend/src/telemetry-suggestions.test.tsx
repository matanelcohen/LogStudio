import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TelemetrySourcesDialog } from "./TelemetrySourcesDialog";
import { TelemetryWorkspace } from "./TelemetryWorkspace";
import {
  fetchDiscoveredTelemetrySources, readApprovedProjectFiles, readDiscoveredTelemetrySources,
  readTelemetrySourceSuggestion, suggestTelemetrySources, validateProjectSourceFiles
} from "./telemetry-suggestions-api";

const settings = { meterSources: "Manual.Meter", activitySources: "Manual.Activity", canConfigure: true };
const discovered = { meterSources: ["Excluded.Meter"], activitySources: ["Excluded.Activity"], omittedMeterSources: 3, omittedActivitySources: 2 };
const suggestion = {
  meterSources: "Suggested.*", activitySources: "Suggested.Activity", explanation: "<b>Not HTML</b>",
  evidence: [
    { kind: "meter", source: "Excluded.Meter", origin: "runtime", file: null, line: null },
    { kind: "activity", source: "Suggested.Activity", origin: "project", file: "Program.cs", line: 7 }
  ],
  warnings: ["Review these patterns."]
};
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function meterInput() { return screen.getByRole("textbox", { name: "Meter source patterns" }) as HTMLInputElement; }
function suggestButton() { return screen.getByRole("button", { name: "Suggest sources" }) as HTMLButtonElement; }
function mockFetch(suggestResponse: () => Promise<Response> = () => Promise.resolve(response(suggestion))) {
  const fetch = vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith("/sources")) return Promise.resolve(response(discovered));
    if (url.endsWith("/suggest")) return suggestResponse();
    if (url.endsWith("/settings")) return Promise.resolve(response(options?.method === "POST" ? { ...settings, ...JSON.parse(options.body as string) } : settings));
    return Promise.resolve(response({ enabled: true, metrics: [], spans: [], droppedMetrics: 0, droppedSpans: 0 }));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Configure sources" }));
  await screen.findByRole("textbox", { name: "Meter source patterns" });
}
function approve() { fireEvent.click(screen.getByRole("checkbox")); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function file(name: string, content: string, size = content.length) {
  return { name, size, text: vi.fn().mockResolvedValue(content) } as unknown as File;
}

describe("source suggestion API boundaries", () => {
  it("uses relative discovery and suggestion routes, explicit consent, default empty files and the action header", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(discovered)).mockResolvedValueOnce(response(suggestion));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await fetchDiscoveredTelemetrySources(signal)).toEqual(discovered);
    expect(fetch).toHaveBeenNthCalledWith(1, "api/telemetry/sources", { signal });
    expect(await suggestTelemetrySources(true, undefined, signal)).toEqual(suggestion);
    expect(fetch).toHaveBeenNthCalledWith(2, "api/telemetry/suggest", {
      method: "POST", signal, headers: { "Content-Type": "application/json", "X-Log-Studio-Action": "telemetry-suggest" },
      body: JSON.stringify({ consent: true, projectFiles: [] })
    });
  });

  it("never sends a request without consent or for invalid files", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(suggestTelemetrySources(false)).rejects.toThrow(/consent/);
    for (const files of [
      [{ name: "secret.env", content: "" }], [{ name: "../Program.cs", content: "" }],
      [{ name: "Program.cs", content: "x".repeat(32769) }], Array(9).fill({ name: "x.cs", content: "" }),
      Array(3).fill({ name: "x.json", content: "x".repeat(32768) })
    ]) await expect(suggestTelemetrySources(true, files)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(() => validateProjectSourceFiles([{ name: "x.cs", content: "x".repeat(32768) }, { name: "x.json", content: "x".repeat(32768) }])).not.toThrow();
  });

  it("checks count, extensions and bytes before reading and rejects entire oversized selections", async () => {
    for (const selected of [[file("x.env", "")], [file("x.cs", "", 131073)], Array(9).fill(file("x.cs", ""))]) {
      await expect(readApprovedProjectFiles(selected)).rejects.toThrow();
      for (const entry of selected) expect(entry.text).not.toHaveBeenCalled();
    }
    await expect(readApprovedProjectFiles([file("ok.cs", ""), file("big.cs", "x".repeat(32769))])).rejects.toThrow(/32768/);
    await expect(readApprovedProjectFiles(Array(3).fill(file("x.cs", "x".repeat(32768))))).rejects.toThrow(/65536/);
    expect(await readApprovedProjectFiles([file("Program.CS", "new Meter(\"App\")")])).toEqual([{ name: "Program.CS", content: "new Meter(\"App\")" }]);
  });

  it.each([
    { ...discovered, meterSources: Array(257).fill("x") },
    { ...discovered, activitySources: ["x".repeat(257)] },
    { ...discovered, omittedMeterSources: -1 }, { ...discovered, omittedActivitySources: 1.2 },
    { ...discovered, meterSources: "not an array" }
  ])("rejects malformed or unbounded discovery %j", value => {
    expect(() => readDiscoveredTelemetrySources(value)).toThrow();
  });

  it("accepts discovery maximums and validates all suggestion bounds and evidence provenance", () => {
    expect(readDiscoveredTelemetrySources({ ...discovered, meterSources: Array(256).fill("x".repeat(256)) }).meterSources).toHaveLength(256);
    for (const value of [
      { ...suggestion, meterSources: "x".repeat(4097) }, { ...suggestion, activitySources: Array(65).fill("*").join(",") },
      { ...suggestion, explanation: "x".repeat(4001) }, { ...suggestion, evidence: Array(129).fill(suggestion.evidence[0]) },
      { ...suggestion, warnings: Array(9).fill("x") }, { ...suggestion, warnings: ["x".repeat(513)] },
      ...[
        { kind: "log" }, { origin: "other" }, { source: "x".repeat(257) },
        { file: "Program.cs" }, { line: 1 }, { file: undefined }, { line: undefined },
        { origin: "project", file: null }, { origin: "project", file: "x.cs", line: 0 },
        { origin: "project", file: "x".repeat(257), line: 2 }, { origin: "project", file: "x.cs", line: 1.5 }
      ].map(change => ({ ...suggestion, evidence: [{ ...suggestion.evidence[0], ...change }] }))
    ]) expect(() => readTelemetrySourceSuggestion(value)).toThrow();
    expect(readTelemetrySourceSuggestion({
      ...suggestion, meterSources: "x".repeat(4096), explanation: "x".repeat(4000),
      evidence: Array(128).fill(suggestion.evidence[0]), warnings: Array(8).fill("x".repeat(512))
    }).evidence).toHaveLength(128);
  });

  it("rejects discovery and suggestion HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 503)));
    await expect(fetchDiscoveredTelemetrySources(new AbortController().signal)).rejects.toThrow("HTTP 503");
    await expect(suggestTelemetrySources(true)).rejects.toThrow("HTTP 503");
  });
});

describe("opt-in source suggestion dialog", () => {
  it("discovers only when open, includes excluded sources and omitted counts, refreshes independently, never automatically suggests", async () => {
    const fetch = mockFetch();
    render(<TelemetrySourcesDialog />);
    expect(fetch).not.toHaveBeenCalled();
    await open();
    await screen.findByText("Excluded.Meter");
    expect(screen.getByText("Excluded.Activity")).toBeDefined();
    expect(screen.getByText("3 meter source discovery notifications omitted (may repeat).")).toBeDefined();
    expect(screen.getByText("2 activity source discovery notifications omitted (may repeat).")).toBeDefined();
    fireEvent.change(meterInput(), { target: { value: "My.Draft" } });
    approve();
    await flush();
    expect(fetch.mock.calls.every(([url]) => !url.endsWith("/suggest"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith("/sources"))).toHaveLength(2));
    expect(meterInput().value).toBe("My.Draft");
  });

  it("keeps discovery errors independent of settings and manual editing", async () => {
    const fetch = mockFetch();
    fetch.mockImplementation((url: string) => Promise.resolve(url.endsWith("/sources") ? response({}, 503) : response(settings)));
    render(<TelemetrySourcesDialog />);
    await open();
    await screen.findByText(/Could not discover/);
    fireEvent.change(meterInput(), { target: { value: "Still.Editable" } });
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false);
    expect(meterInput().value).toBe("Still.Editable");
  });

  it("requests runtime-only suggestions only with checked consent, previews safely, then requires Use and Apply", async () => {
    let finish!: (value: Response) => void;
    const fetch = mockFetch(() => new Promise(resolve => { finish = resolve; }));
    render(<TelemetrySourcesDialog />);
    await open();
    expect(suggestButton().disabled).toBe(true);
    fireEvent.click(suggestButton());
    approve();
    expect(suggestButton().disabled).toBe(false);
    fireEvent.click(suggestButton());
    fireEvent.click(suggestButton());
    fireEvent.change(meterInput(), { target: { value: "Edited.While.Pending" } });
    const call = fetch.mock.calls.find(([url]) => url.endsWith("/suggest"))!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ consent: true, projectFiles: [] });
    finish(response(suggestion));
    await screen.findByText("Review suggestion");
    expect(meterInput().value).toBe("Edited.While.Pending");
    expect(screen.getByText("<b>Not HTML</b>").querySelector("b")).toBeNull();
    expect(screen.getByText("Review these patterns.")).toBeDefined();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(meterInput().value).toBe("Suggested.*");
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/Source patterns applied to native capture/);
    const save = fetch.mock.calls.find(([url, options]) => url.endsWith("/settings") && options?.method === "POST")!;
    expect(JSON.parse(save[1]!.body as string)).toEqual({ meterSources: "Suggested.*", activitySources: "Suggested.Activity" });
  });

  it("preserves manual drafts after failed suggestions", async () => {
    mockFetch(() => Promise.resolve(response({}, 500)));
    render(<TelemetrySourcesDialog />);
    await open();
    fireEvent.change(meterInput(), { target: { value: "Keep.Draft" } });
    approve(); fireEvent.click(suggestButton());
    await screen.findByText(/Could not suggest/);
    expect(meterInput().value).toBe("Keep.Draft");
    expect(screen.queryByText("Review suggestion")).toBeNull();
    expect(suggestButton().disabled).toBe(false);
  });

  it("previews only picked filenames, removes and clears files, and uploads only on explicit Suggest", async () => {
    const fetch = mockFetch();
    render(<TelemetrySourcesDialog />);
    await open(); approve();
    const picker = screen.getByLabelText("Approved project files");
    fireEvent.change(picker, { target: { files: [file("One.cs", "one"), file("Two.props", "two")] } });
    await screen.findByRole("button", { name: "Remove One.cs" });
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/suggest"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove One.cs" }));
    fireEvent.click(suggestButton());
    await screen.findByText("Review suggestion");
    const call = fetch.mock.calls.find(([url]) => url.endsWith("/suggest"))!;
    expect(JSON.parse(call[1]!.body as string).projectFiles).toEqual([{ name: "Two.props", content: "two" }]);
    fireEvent.click(screen.getByRole("button", { name: "Clear approved files" }));
    expect(screen.queryByRole("button", { name: "Remove Two.props" })).toBeNull();
    fireEvent.change(picker, { target: { files: [file("Valid.cs", "valid"), file("Invalid.env", "invalid")] } });
    await screen.findByText(/No files will be submitted/);
    expect(suggestButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove Valid.cs" })).toBeNull();
    fireEvent.click(suggestButton());
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/suggest"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear approved files" }));
    expect(suggestButton().disabled).toBe(false);
  });

  it("ignores late local file reads after clearing the selection", async () => {
    mockFetch(); render(<TelemetrySourcesDialog />); await open(); approve();
    let finish!: (value: string) => void;
    fireEvent.change(screen.getByLabelText("Approved project files"), {
      target: { files: [{ name: "Late.cs", size: 1, text: () => new Promise(resolve => { finish = resolve; }) }] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear approved files" }));
    finish("late"); await flush();
    expect(screen.queryByRole("button", { name: "Remove Late.cs" })).toBeNull();
    expect(suggestButton().disabled).toBe(false);
  });

  it("keeps suggestions disabled for completed or disabled capture", async () => {
    const fetch = mockFetch();
    fetch.mockImplementation((url: string) => Promise.resolve(response(url.endsWith("/sources") ? discovered : { ...settings, canConfigure: false })));
    render(<TelemetrySourcesDialog />);
    await open();
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(suggestButton().disabled).toBe(true);
    fireEvent.click(suggestButton());
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/suggest"))).toBe(false);
  });

  it.each(["close", "archive", "unmount"])("aborts independent discovery and suggestion requests on %s and ignores stale results", async transition => {
    let finishSuggestion!: (value: Response) => void;
    let finishDiscovery!: (value: Response) => void;
    const fetch = mockFetch(() => new Promise(resolve => { finishSuggestion = resolve; }));
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation((url, options) => url.endsWith("/sources") ?
      new Promise(resolve => { finishDiscovery = resolve; }) : original(url, options));
    const { rerender, unmount } = render(<TelemetryWorkspace view="metrics" archived={false} />);
    await open(); approve(); fireEvent.click(suggestButton());
    const pending = fetch.mock.calls.filter(([url]) => url.endsWith("/sources") || url.endsWith("/suggest"));
    if (transition === "close") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else if (transition === "archive") rerender(<TelemetryWorkspace view="metrics" archived />);
    else unmount();
    for (const [, options] of pending) expect(options!.signal!.aborted).toBe(true);
    finishSuggestion(response(suggestion)); finishDiscovery(response(discovered)); await flush();
    expect(screen.queryByText("Review suggestion")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetch.mock.calls.filter(([url, options]) => url.endsWith("/settings") && options?.method === "POST")).toHaveLength(0);
    if (transition === "close") {
      await open();
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
      expect(screen.queryByText("Review suggestion")).toBeNull();
    }
  });

  it("never discovers or suggests in an archive", () => {
    const fetch = mockFetch();
    render(<TelemetryWorkspace view="metrics" archived />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Configure sources" })).toBeNull();
  });
});
