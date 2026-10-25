import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdates } from "./AppUpdates";
import * as api from "./api";
import { useAppUpdate } from "./useAppUpdate";

const initial: api.AppUpdateState = {
  currentVersion: "1.8.1", automaticCheck: true, release: null, updateAvailable: false,
  installationUnavailableReason: null, installedVersion: null
};
const available: api.AppUpdateState = {
  ...initial, updateAvailable: true,
  release: {
    version: "1.9.0", name: "Log Studio 1.9.0", notes: "## Changes\n\nA useful **fix**.\n\n![remote](https://example.invalid/track.png)\n\n<script>alert('bad')</script>",
    url: "https://github.com/matanelcohen/LogStudio/releases/tag/1.9.0", publishedAt: "2026-10-24T10:00:00Z"
  }
};
afterEach(() => vi.restoreAllMocks());

function Workspace() {
  return <AppUpdates updates={useAppUpdate()} />;
}

describe("application updates", () => {
  it("checks once in StrictMode and never installs automatically", async () => {
    const request = vi.spyOn(api, "appUpdate").mockResolvedValueOnce(initial).mockResolvedValue(available);
    render(<StrictMode><Workspace /></StrictMode>);
    await screen.findByText("Version 1.9.0 is available.");
    expect(request.mock.calls).toEqual([[], ["check-update"]]);
    expect(screen.getByLabelText("Release notes").textContent).toContain("A useful fix.");
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector(".update-notes script")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download and install" })).toBeNull();
  });

  it("requires confirmation, pins the reviewed release and reports restart without stopping capture", async () => {
    const request = vi.spyOn(api, "appUpdate").mockResolvedValueOnce(available);
    let complete!: (state: api.AppUpdateState) => void;
    render(<Workspace />);
    await screen.findByText("Version 1.9.0 is available.");
    fireEvent.click(screen.getByRole("button", { name: "Install update..." }));
    expect(request).toHaveBeenCalledTimes(1);
    request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
    expect(screen.getByRole("button", { name: "Downloading and installing..." }).hasAttribute("disabled")).toBe(true);
    expect(request).toHaveBeenLastCalledWith("install-update", "1.9.0");
    await act(async () => complete({ ...available, installedVersion: "1.9.0", updateAvailable: false }));
    expect(screen.getByText(/Close and relaunch Log Studio/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Install update..." })).toBeNull();
  });

  it("does not contact GitHub automatically for embedded copies and explains unsupported installs", async () => {
    const request = vi.spyOn(api, "appUpdate").mockResolvedValue({
      ...initial, automaticCheck: false, installationUnavailableReason: "Update your dotnet tool or rebuild from source."
    });
    render(<Workspace />);
    await screen.findByText("Installed version 1.8.1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Update your dotnet tool/)).toBeDefined();
    request.mockResolvedValue({ ...available, installationUnavailableReason: "Update your dotnet tool or rebuild from source." });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("Version 1.9.0 is available.");
    expect(screen.queryByRole("button", { name: "Install update..." })).toBeNull();
  });

  it("surfaces offline and installation failures and permits retry", async () => {
    const request = vi.spyOn(api, "appUpdate").mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("Offline."));
    render(<Workspace />);
    expect((await screen.findByRole("alert")).textContent).toBe("Offline.");
    request.mockResolvedValueOnce(available);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("Version 1.9.0 is available.");
    request.mockRejectedValueOnce(new Error("Checksum verification failed."));
    fireEvent.click(screen.getByRole("button", { name: "Install update..." }));
    fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Checksum verification failed.");
    expect(screen.queryByText(/is installed/)).toBeNull();
    expect(screen.getByRole("button", { name: "Download and install" }).hasAttribute("disabled")).toBe(false);
  });

  it("suppresses duplicate installation clicks before React updates", async () => {
    const request = vi.spyOn(api, "appUpdate").mockResolvedValue(available);
    const { result } = renderHook(useAppUpdate);
    await waitFor(() => expect(result.current.busy).toBeNull());
    await act(async () => { await Promise.all([result.current.install(), result.current.install()]); });
    expect(request.mock.calls.filter(call => call[0] === "install-update")).toHaveLength(1);
  });

  it("sends protected API actions and validates release links", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(available)));
    vi.stubGlobal("fetch", fetch);
    expect(await api.appUpdate("install-update", "1.9.0")).toEqual(available);
    expect(fetch).toHaveBeenCalledWith("api/app-update?version=1.9.0", {
      method: "POST", headers: { "X-Log-Studio-Action": "install-update" }
    });
    fetch.mockResolvedValue(new Response(JSON.stringify({ ...available, release: { ...available.release, url: "javascript:alert(1)" } })));
    await expect(api.appUpdate()).rejects.toThrow("invalid release metadata");
    fetch.mockResolvedValue(new Response(JSON.stringify({ error: "Rate limited." }), { status: 409 }));
    await expect(api.appUpdate("check-update")).rejects.toThrow("Rate limited.");
  });
});
