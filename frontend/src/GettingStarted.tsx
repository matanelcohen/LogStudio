import * as Oui from "@opensearch-project/oui";
import type { ReactNode } from "react";
import type { ViewerStatus } from "./model";

interface GettingStartedProps {
  canChooseApp: boolean;
  dismissed?: boolean;
  sampleBusy: boolean;
  onChooseApp(): void;
  onImport(): void;
  onSample(): void;
  onDismiss?(): void;
}

export function GettingStarted({ canChooseApp, dismissed, sampleBusy, onChooseApp, onImport, onSample, onDismiss }: GettingStartedProps) {
  return <div className="getting-started">
    <h3>{dismissed ? "Ready for logs" : "Get your first useful log"}</h3>
    <div className="empty-state-actions">
      {canChooseApp && <Oui.Button variant="default" size="sm" onClick={onChooseApp}>Choose running app</Oui.Button>}
      <Oui.Button variant="outline" size="sm" onClick={onImport}>Import a session</Oui.Button>
      <Oui.Button variant="outline" size="sm" disabled={sampleBusy} onClick={onSample}>{sampleBusy ? "Loading demo…" : "Try sample logs"}</Oui.Button>
      {!dismissed && onDismiss && <Oui.Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss getting started</Oui.Button>}
    </div>
    <p className="muted">Demo: bundled synthetic logs, available offline. No app is started or attached. Then search for <code>timeout</code> or filter by level.</p>
    {!dismissed && <>
      <p><strong>Running app</strong> attaches only when you choose an app. It captures new ILogger events, requires the .NET logging EventSource provider (Microsoft-Extensions-Logging), and cannot recover historical stdout/stderr.</p>
      <p><strong>Import</strong> opens existing Log Studio session bundles or JSONL files in a separate saved session. <strong>CLI</strong> wrapping captures a command’s stdout/stderr from launch: <code>logstudio --open -- &lt;command&gt;</code>. Start commands yourself in a terminal.</p>
    </>}
    {!canChooseApp && <p>To attach to a running app, use the desktop app or start <code>logstudio --listen-all --open</code> yourself.</p>}
  </div>;
}

export function LogEmptyState({ status, archived, listening, paused, matchCount, gettingStarted, onReset, onRefresh, onNewest, onChooseApp, onImport, onResume }: {
  status: ViewerStatus;
  archived: boolean;
  listening: boolean;
  paused: boolean;
  matchCount: number;
  gettingStarted: ReactNode;
  onReset(): void;
  onRefresh(): void;
  onNewest(): void;
  onChooseApp(): void;
  onImport(): void;
  onResume(): void;
}) {
  if (matchCount > 0) return <>
    <h3>No entries on this page</h3><p>Matching logs are available outside this page.</p>
    <Oui.Button variant="outline" size="sm" onClick={onNewest}>Show newest matches</Oui.Button>
  </>;
  if (status.retainedCount > 0) return <>
    <h3>No matching entries</h3><p>Change your query or reset filters to restore entries hidden by Clear view. Your selected session and page size stay the same.</p>
    <Oui.Button variant="outline" size="sm" onClick={onReset}>Reset filters</Oui.Button>
  </>;
  if (!archived && status.listenAll && !listening) return gettingStarted;
  if (!archived && paused) return <>
    <h3>Live updates are paused</h3><p>Capture continues. Resume to see new entries in this tab.</p>
    <Oui.Button variant="outline" size="sm" onClick={onResume}>Resume live updates</Oui.Button>
  </>;
  if (!archived && status.listenAll && !status.isCompleted) return <>
    <h3>Attached, waiting for events</h3>
    <p>Trigger activity in your app that emits new ILogger events. Enable the .NET logging EventSource provider (Microsoft-Extensions-Logging) and check its log level. Attaching cannot recover historical stdout/stderr.</p>
    <div className="empty-state-actions"><Oui.Button variant="outline" size="sm" onClick={onRefresh}>Refresh history</Oui.Button>
      <Oui.Button variant="outline" size="sm" onClick={onChooseApp}>Choose another app</Oui.Button></div>
  </>;
  return <>
    <h3>{archived || status.isCompleted ? "This session has no entries" : "Waiting for command output"}</h3>
    <p>{archived || status.isCompleted ? "No retained logs are available in this session. Open another session or import an existing history." :
      "The CLI captures new stdout/stderr from the wrapped command. Trigger activity in that command; older terminal output is not recovered."}</p>
    <Oui.Button variant="outline" size="sm" onClick={archived || status.isCompleted ? onImport : onRefresh}>{archived || status.isCompleted ? "Import a session" : "Refresh history"}</Oui.Button>
  </>;
}
