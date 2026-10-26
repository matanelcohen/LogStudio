import * as Oui from "@opensearch-project/oui";

import { Calendar, Download, FileUp, FolderOpen, History, Pencil, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { deleteSession, fetchSessions, renameSession } from "./api";
import { buildSessionExportUrl, errorMessage, MaximumSessionNameLength, NumberFormatter, type SessionInfo } from "./model";
import { SessionImportDialog } from "./SessionImportDialog";

const SessionDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function SessionsDialog({ open, selected, onClose, onSelect, onRenamed, onDeleted, returnFocus }: {
  open: boolean;
  selected: string;
  onClose(): void;
  onSelect(session: SessionInfo): void;
  onRenamed?(session: SessionInfo): void;
  onDeleted?(id: string): void;
  returnFocus(): void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<{ kind: "rename" | "delete"; session: SessionInfo } | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const importOpener = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const actionButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (!open) setAction(null); }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchSessions(controller.signal).then(setSessions).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, revision]);
  const query = search.toLowerCase();
  const matches = sessions.filter(session => [session.name, session.command, session.workingDirectory, session.startedAt, ...session.arguments]
    .some(value => value?.toLowerCase().includes(query)));
  function openImport(event: MouseEvent<HTMLButtonElement>) {
    importOpener.current = event.currentTarget;
    setImportOpen(true);
  }
  async function manage() {
    if (!action || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "rename") {
        const renamed = await renameSession(action.session.id, newName);
        setSessions(sessions => sessions.map(session => session.id === renamed.id ? renamed : session));
        onRenamed?.(renamed);
      }
      else { await deleteSession(action.session.id); onDeleted?.(action.session.id); }
      setAction(null);
      setRevision(value => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <><Oui.Dialog open={open} onOpenChange={open => { if (!open && !busy) onClose(); }}>

      <Oui.DialogContent showCloseButton={false} className="sessions-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
        <div className="dialog-titlebar"><div className="dialog-icon"><History size={20} /></div><div>
          <Oui.DialogTitle>Sessions</Oui.DialogTitle><Oui.DialogDescription>Find a run by name, date, command, arguments, or working directory.</Oui.DialogDescription>
        </div><Oui.DialogClose asChild><Oui.Button variant="ghost" size="sm" className="icon-button" aria-label="Close sessions" disabled={busy}><X size={18} /></Oui.Button></Oui.DialogClose></div>
        <div className="sessions-content">
          <div className="sessions-toolbar"><div className="search-box"><Search size={15} /><Oui.Input ref={searchInput} aria-label="Find sessions" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, date, command or parameter…" /></div>
            <Oui.Button variant="default" size="sm" id="importSession" ref={importButton} className="primary" disabled={busy} onClick={openImport}><FileUp size={14} />Import</Oui.Button>
            <Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Refresh sessions" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} /></Oui.Button></div>
          <div className="sessions-overview"><span>{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span><span>{NumberFormatter.format(sessions.reduce((count, session) => count + session.entryCount, 0))} retained entries</span><span>Private local storage</span></div>
          {loading && <p className="muted">Loading saved sessions…</p>}
          {error && <Oui.Alert variant="destructive" className="notice danger" role="alert">{error}</Oui.Alert>}
          <div className="session-list">
            {matches.map(session => <article key={session.id} className="session-card">
              <div className="session-heading"><div><h3>{session.name} {session.isCurrent && <span className="count-pill">Current run</span>}</h3>
                <p className="muted"><Calendar size={12} /> {SessionDate.format(new Date(session.startedAt))} · {NumberFormatter.format(session.entryCount)} entries
                  {session.completedAt ? ` · exit ${session.exitCode ?? "unknown"}` : " · running"}</p></div>
                <div className="session-card-actions">
                  <a className={Oui.buttonVariants({ variant: "outline", size: "sm" })} aria-label={`Export ${session.name}`} href={buildSessionExportUrl(session.isCurrent ? "" : session.id)} download><Download size={13} /></a>
                  <Oui.Button variant="ghost" size="icon" className="icon-button" disabled={busy} aria-label={`Rename ${session.name}`} title="Rename session"
                    onClick={(event: MouseEvent<HTMLButtonElement>) => { actionButton.current = event.currentTarget; setAction({ kind: "rename", session }); setNewName(session.name); setError(null); }}><Pencil size={13} /></Oui.Button>
                  <Oui.Button variant="ghost" size="icon" className="icon-button" disabled={session.isCurrent || busy} aria-label={`Delete ${session.name}`} title={session.isCurrent ? "Clear logs to reset the current run" : "Delete saved session"}
                    onClick={(event: MouseEvent<HTMLButtonElement>) => { actionButton.current = event.currentTarget; setAction({ kind: "delete", session }); setError(null); }}><Trash2 size={13} /></Oui.Button>
                  <Oui.Button variant="outline" size="sm" className="small" disabled={busy || (session.isCurrent ? !selected : selected === session.id)} onClick={() => onSelect(session)}><FolderOpen size={13} />{session.isCurrent ? "View current" : "View session"}</Oui.Button>
                </div>
              </div>
              <details><summary>Run parameters</summary><dl className="metadata">
                <dt>Session ID</dt><dd>{session.id}</dd><dt>Command</dt><dd>{session.command ?? "In-process attachment"}</dd>
                <dt>Directory</dt><dd>{session.workingDirectory}</dd><dt>Arguments</dt><dd><pre>{session.arguments.length ? session.arguments.join("\n") : "No arguments"}</pre></dd>
              </dl></details>
            </article>)}
            {!loading && !error && !sessions.some(session => !session.isCurrent) && !search && <div className="empty-state">
              <h3>No saved sessions yet</h3><p>Completed captures are saved locally when Log Studio closes. Import a session bundle or Log Studio JSONL file to open existing logs without starting a command.</p>
              <Oui.Button variant="outline" size="sm" onClick={openImport}>Import a session</Oui.Button>
            </div>}
            {!loading && !error && !matches.length && !!search && <div className="empty-state">
              <h3>No matching saved sessions</h3><p>Try another name, date, or command.</p>
              <Oui.Button variant="outline" size="sm" onClick={() => { setSearch(""); searchInput.current?.focus(); }}>Clear search</Oui.Button>
            </div>}
          </div>
          <p className="muted">Saved histories remain on private local disk across restarts. Common secret flags are redacted from parameters; log contents are not automatically redacted.</p>
        </div>
      </Oui.DialogContent>

  </Oui.Dialog>
    <Oui.Dialog open={action !== null} onOpenChange={open => { if (!open && !busy) setAction(null); }}>

        <Oui.DialogContent showCloseButton={false} className="session-management-panel" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
          onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
          onCloseAutoFocus={event => { event.preventDefault(); if (actionButton.current?.isConnected) actionButton.current.focus(); else importButton.current?.focus(); }}>
          <Oui.DialogTitle>{action?.kind === "rename" ? "Rename session" : "Delete saved session?"}</Oui.DialogTitle>
          <Oui.DialogDescription>{action?.kind === "rename" ? "Use a recognizable name to find this run later." : `Permanently remove ${action?.session.name}, its log files, and run metadata. Export it first if you want a backup.`}</Oui.DialogDescription>
          {action?.kind === "rename" && <Oui.Input aria-label="New session name" value={newName} maxLength={MaximumSessionNameLength} disabled={busy} onChange={event => setNewName(event.target.value)} />}
          {error && <Oui.Alert variant="destructive" className="notice danger" role="alert">{error}</Oui.Alert>}
          <div className="dialog-footer"><Oui.Button variant="outline" size="sm" disabled={busy} onClick={() => { setAction(null); setError(null); }}>Cancel</Oui.Button>
            <Oui.Button variant="outline" size="sm" className={action?.kind === "delete" ? "danger-button" : "primary"} disabled={busy || (action?.kind === "rename" && !newName.trim())} onClick={manage}>
              {busy ? "Working…" : action?.kind === "rename" ? "Save name" : "Delete saved session"}
            </Oui.Button></div>
        </Oui.DialogContent>

    </Oui.Dialog>
    <SessionImportDialog open={importOpen} onClose={() => setImportOpen(false)} returnFocus={() => {
      if (importOpener.current?.isConnected) importOpener.current.focus();
      else importButton.current?.focus();
    }}
      onImported={session => { setImportOpen(false); setRevision(value => value + 1); onSelect(session); }} />
  </>;
}
