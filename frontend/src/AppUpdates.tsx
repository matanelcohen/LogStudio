import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { useAppUpdate } from "./useAppUpdate";

const MarkdownPlugins = [remarkGfm];

export function AppUpdates({ updates }: { updates: ReturnType<typeof useAppUpdate> }) {
  const [confirm, setConfirm] = useState(false);
  const { state, busy, error } = updates;
  const release = state?.release;
  const canInstall = state?.updateAvailable && !state.installationUnavailableReason && !state.installedVersion;
  return <fieldset className="settings-group app-updates">
    <legend>Updates</legend>
    <div className="settings-row">
      <span>{state ? `Installed version ${state.currentVersion}` : "Log Studio updates"}</span>
      <button disabled={busy !== null || !!state?.installedVersion} onClick={() => { setConfirm(false); void updates.check(); }}>
        <RefreshCw size={14} /> {busy === "checking" ? "Checking..." : "Check for updates"}
      </button>
    </div>
    <p className="muted">Checks contact GitHub for public release metadata only; no logs are sent. Desktop and CLI launches check once. Installation is always your choice.</p>
    {error && <p className="notice danger" role="alert">{error}</p>}
    {state?.installedVersion ? <p className="notice" role="status">
      Version {state.installedVersion} is installed. Close and relaunch Log Studio to use it. Current capture and other running sessions are unchanged.
    </p> : <>
      {release && <p role="status">{state?.updateAvailable ? `Version ${release.version} is available.` : "No newer stable version is available."}</p>}
      {state?.installationUnavailableReason && <p className="muted">{state.installationUnavailableReason}</p>}
      {release && <>
        <h3>{release.name || `Version ${release.version}`}</h3>
        <div className="update-notes" aria-label="Release notes">
          {release.notes ? <Markdown remarkPlugins={MarkdownPlugins} skipHtml components={{
            img: () => null,
            a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>
          }}>{release.notes}</Markdown> : <p>No release notes were provided.</p>}
        </div>
        <a href={release.url} target="_blank" rel="noreferrer">View release on GitHub</a>
      </>}
      {canInstall && <div className="update-install">
        {confirm || busy === "installing" ? <>
          <p>Download and install version {release?.version} for this app? The archive is SHA-256 verified before switching the launcher. The other app (CLI or desktop) is not changed. Relaunch when you are ready.</p>
          <div className="dialog-footer">
            <button disabled={busy !== null} onClick={() => setConfirm(false)}>Cancel update</button>
            <button className="primary" disabled={busy !== null} onClick={() => { void updates.install(); }}>
              <Download size={14} /> {busy === "installing" ? "Downloading and installing..." : "Download and install"}
            </button>
          </div>
        </> : <button className="primary" disabled={busy !== null} onClick={() => setConfirm(true)}><Download size={14} /> Install update...</button>}
      </div>}
    </>}
  </fieldset>;
}
