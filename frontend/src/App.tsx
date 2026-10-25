import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AlertCircle, Check, ChevronDown, ChevronRight, Clock3, Compass, Database, FileUp, HardDrive, History, Logs, MessageSquare, Monitor, Moon, Pause, Play, Settings, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConditionDialog } from "./ConditionDialog";
import { ClearHistoryDialog } from "./ClearHistoryDialog";
import { SessionsDialog } from "./SessionsDialog";
import { SessionImportDialog } from "./SessionImportDialog";
import { CopilotChatPanel } from "./CopilotChatPanel";
import { SettingsDialog } from "./SettingsDialog";
import { TerminalInput } from "./TerminalInput";
import { DiscoverSidebar } from "./DiscoverSidebar";
import { clearSessionLogs, fetchApplications, selectApplication } from "./api";
import { Inspector } from "./Inspector";
import { LogTable } from "./LogTable";
import {
  defaultQuery, errorMessage, NumberFormatter, readChoice, TimeFormatter, validateConditions,
  type LogCondition, type LogEntry, type Notice, type PageCursor, type QueryState, type RunningApplication, type RunningApplicationsState, type SessionInfo, type ViewerStatus
} from "./model";
import { QueryBar } from "./QueryBar";
import { Hint } from "./ui";
import { AppearanceChoices, useAppearance } from "./useAppearance";
import { useTypography } from "./useTypography";
import { useLiveStatus, useLogPage } from "./useLogExplorer";
import { useSessionFilters } from "./useSessionFilters";

interface PauseSnapshot { maximumId: number; status: ViewerStatus | null; }

export default function App() {
  const [query, setQuery] = useState<QueryState>(defaultQuery);
  const [cursor, setCursor] = useState<PageCursor>({ before: null, after: null });
  const [pause, setPause] = useState<PauseSnapshot | null>(null);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [inspector, setInspector] = useState(false);
  const [fields, setFields] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; seed: LogCondition | null }>({ open: false, seed: null });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [applicationListening, setApplicationListening] = useState(false);
  const filters = useSessionFilters(
    filters => setQuery(query => query.sessionId ? query : { ...query, ...filters }),
    error => setNotice({ tone: "warning", message: `Could not save or restore session filters: ${errorMessage(error)}` })
  );
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const clearOpener = useRef<HTMLButtonElement>(null);
  const sessionsOpener = useRef<HTMLButtonElement>(null);
  const importOpener = useRef<HTMLButtonElement>(null);
  const chatOpener = useRef<HTMLButtonElement>(null);
  const settingsOpener = useRef<HTMLButtonElement>(null);
  const seenClear = useRef(0);
  const seenHistory = useRef<string | null>(null);
  const appearance = useAppearance();
  const typography = useTypography();
  const live = useLiveStatus(pause !== null);
  const archived = !!query.sessionId;
  const historyDirectory = live.status?.listenAll ? live.status.historyDirectory : "";
  const clearedThroughId = archived ? 0 : live.status?.clearedThroughId ?? 0;
  const history = useLogPage(query, cursor, archived ? null : pause?.maximumId ?? null, archived ? 0 : live.status?.revision ?? 0, archived || pause !== null, clearedThroughId, archived ? "" : historyDirectory);
  const status = archived ? history.page?.status ?? null : pause?.status && pause.status.clearedThroughId >= clearedThroughId && (!historyDirectory || pause.status.historyDirectory === historyDirectory) ?
    { ...pause.status, applicationName: live.status?.applicationName ?? pause.status.applicationName } :
    live.status ?? history.page?.status ?? null;
  const visibleSelection = selected && selected.id > (status?.clearedThroughId ?? 0) ? selected : null;

  useEffect(() => {
    if (!status || status.isCompleted) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status?.isCompleted]);
  useEffect(() => {
    if (live.gap) setNotice({ tone: "warning", message: live.gap });
  }, [live.gap]);
  useEffect(() => {
    const previous = seenHistory.current;
    seenHistory.current = historyDirectory || null;
    if (!previous || previous === historyDirectory || archived) return;
    seenClear.current = clearedThroughId;
    setQuery(query => ({ ...defaultQuery(), pageSize: query.pageSize }));
    setCursor({ before: null, after: null }); setSelected(null); setPause(null); setFollow(true);
    setChatOpen(false); setClearOpen(false); setNotice(null);
  }, [historyDirectory, archived]);
  useEffect(() => {
    if (clearedThroughId <= seenClear.current) return;
    seenClear.current = clearedThroughId;
    setSelected(null);
    setPause(null);
    setFollow(true);
    setCursor({ before: null, after: null });
    setQuery(query => ({ ...query, dismissedThrough: 0 }));
  }, [clearedThroughId]);
  useEffect(() => {
    if (cursor.after === null || !history.page || history.loading) return;
    const lastId = history.page.entries.at(-1)?.id ?? cursor.after;
    setCursor({ before: lastId + 1, after: null });
  }, [cursor, history.page, history.loading]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") || (event.key === "/" && !editing)) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === "Escape" && target === searchRef.current) {
        const next = { ...query, search: "" };
        setQuery(next);
        filters.save(next, true);
        setCursor({ before: null, after: null });
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [query]);

  function changeQuery(query: QueryState, forceFilters = false) {
    setQuery(query);
    filters.save(query, forceFilters);
    setCursor({ before: follow ? null : (status?.lastId ?? 0) + 1, after: null });
  }

  function selectSession(session: SessionInfo) {
    setQuery({ ...defaultQuery(), ...filters.restore(session), pageSize: query.pageSize, sessionId: session.isCurrent ? "" : session.id });
    setCursor({ before: null, after: null }); setSelected(null); setPause(null); setFollow(true);
    setSessionsOpen(false); setImportOpen(false); setNotice(null);
  }

  function addCondition(condition: LogCondition) {
    const conditions = [...query.conditions, condition];
    const error = validateConditions(conditions);
    if (error) return setNotice({ tone: "danger", message: error });
    changeQuery({ ...query, conditions });
  }

  function openEditor(seed: LogCondition | null = null) {
    editorOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor({ open: true, seed });
  }

  async function clearHistory() {
    setClearing(true);
    setClearError(null);
    try {
      const result = await clearSessionLogs(query.sessionId);
      if (!archived && historyDirectory && seenHistory.current !== historyDirectory) return;
      if (!archived) live.applyStatus(result.status);
      setSelected(null);
      setPause(null);
      setFollow(true);
      setCursor({ before: null, after: null });
      setQuery(query => ({ ...query, dismissedThrough: 0 }));
      history.refresh();
      setClearOpen(false);
      setNotice({ tone: "info", message: `Deleted ${NumberFormatter.format(result.deletedCount)} session entries through #${result.status.clearedThroughId}. New output will continue normally.` });
    } catch (error) {
      setClearError(`Could not confirm deletion: ${errorMessage(error)}`);
    } finally {
      setClearing(false);
    }
  }

  const activePage = history.page;
  const connectionLabel = live.connection === "live" ? "Connected" : live.connection === "paused" ? "Paused" :
    live.connection === "reconnecting" ? "Reconnecting" : live.connection === "failed" ? "Disconnected" : "Connecting";
  const elapsed = status ? Math.max(0, Math.floor(((status.completedAt ? Date.parse(status.completedAt) : now) - Date.parse(status.startedAt)) / 1000)) : 0;

  return (
    <Tooltip.Provider delayDuration={400}>
      <div className="discover-shell">
        <a className="skip-link" href="#workspace">Skip to log results</a>
        <nav className="discover-rail" aria-label="Workspace applications">
          <div className="rail-brand" aria-hidden="true"><span className="rail-brand-icon"><Logs size={21} /></span><span className="rail-wordmark">Log Studio</span></div>
          <span className="rail-label" aria-hidden="true">Workspace</span>
          <button className="rail-item active" aria-label="Discover logs" aria-current="page" title="Discover logs" onClick={() => searchRef.current?.focus()}><Compass size={20} /><span>Discover</span></button>
          <button className="rail-item" aria-label="Browse sessions" title="Sessions" onClick={() => setSessionsOpen(true)}><History size={20} /><span>Sessions</span></button>
          <div className="rail-footer"><Monitor size={17} aria-hidden="true" /><div><strong>On this device</strong><span>Local workspace</span></div></div>
        </nav>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <h1>Log Studio</h1><ChevronRight size={14} className="breadcrumb-separator" />
            <button id="sessions" className="session-switcher" ref={sessionsOpener} aria-label="Sessions" onClick={() => setSessionsOpen(true)}>
              <History size={14} /><span id="applicationName">{status?.applicationName ?? "Select a session"}</span><ChevronDown size={12} />
            </button>
            <span id="runStatus" className={`run-state-badge ${status?.isCompleted ? status.exitCode ? "failed" : "finished" : "running"}`}>
              {archived ? "Saved" : status?.isCompleted ? status.exitCode ? `Exit ${status.exitCode}` : "Finished" :
                status?.listenAll ? applicationListening ? "Listening" : "Choose an app" : status ? "Running" : "Connecting"}
            </span>
          </div>
          <div className="header-actions">
            <span id="connection" className={`connection ${live.connection}`} role="status">{archived ? "Saved session" : connectionLabel}</span>
            <button id="importLogs" ref={importOpener} className="ghost-button" onClick={() => setImportOpen(true)}><FileUp size={14} /> Import</button>
            <button ref={chatOpener} className="ghost-button" aria-pressed={chatOpen} disabled={!status}
              onClick={() => setChatOpen(true)}><MessageSquare size={14} /> Ask Copilot</button>
            <Popover.Root>
              <Popover.Trigger asChild><button id="storageInfo" className="icon-button ghost-button" aria-label="Storage details"><HardDrive size={15} /></button></Popover.Trigger>
              <Popover.Portal><Popover.Content className="popover storage-popover" sideOffset={8} align="end">
                <h3><Database size={16} /> Temporary disk history</h3>
                <p>All retained entries stay on disk. The browser caches one {query.pageSize}-entry page.</p>
                <dl><dt>Journal + index</dt><dd>{NumberFormatter.format(status?.journalBytes ?? 0)} bytes</dd>
                  <dt>Write buffers</dt><dd>{NumberFormatter.format(status?.ioBufferBytes ?? 0)} bytes</dd>
                  <dt>Flush cadence</dt><dd>Every {NumberFormatter.format(status?.flushEveryEntries ?? 0)} entries, or before reads</dd></dl>
                <pre>{status?.historyDirectory ?? "Waiting for storage details…"}</pre>
                <p className="muted">Run histories are owner-private. The wrapper saves completed sessions for reopening; temporary capture files are removed on graceful close.</p>
                <a href="third-party-notices.txt" target="_blank" rel="noreferrer">Third-party component licenses</a>
              </Popover.Content></Popover.Portal>
            </Popover.Root>
            <Hint label={pause ? "Resume live updates and catch up from disk." : "Freeze this tab. The command keeps capturing."}>
              <button id="pause" className={pause ? "paused-control" : "ghost-button"} disabled={archived} onClick={() => setPause(pause ? null : { maximumId: status?.lastId ?? 0, status })}>
                {pause ? <Play size={14} /> : <Pause size={14} />}{pause ? "Resume" : "Pause"}
              </button>
            </Hint>
            <Menu.Root>
              <Menu.Trigger asChild><button id="theme" className="icon-button ghost-button" aria-label="Appearance">{appearance.theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}</button></Menu.Trigger>
              <Menu.Portal><Menu.Content className="menu-content" sideOffset={7} align="end">
                <Menu.Label className="menu-label">Appearance</Menu.Label>
                <Menu.RadioGroup value={appearance.appearance} onValueChange={value => appearance.setAppearance(readChoice(value, AppearanceChoices))}>
                  {[
                    { value: "system", label: "System preference", icon: <Monitor size={14} /> },
                    { value: "light", label: "Light Mode", icon: <Sun size={14} /> },
                    { value: "dark", label: "Dark Mode", icon: <Moon size={14} /> }
                  ].map(option => <Menu.RadioItem value={option.value} className="menu-item" key={option.value}>
                    {option.icon}{option.label}<Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator>
                  </Menu.RadioItem>)}
                </Menu.RadioGroup>
              </Menu.Content></Menu.Portal>
            </Menu.Root>
            <button ref={settingsOpener} className="icon-button ghost-button" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={15} /></button>
          </div>
        </header>
        <div className="query-region">
          <div className="workspace-heading">
            <div><span className="workspace-kicker">LOG EXPLORER</span><h2>Discover</h2><p>Search, filter, and inspect your session history.</p></div>
            <span className="workspace-context"><Database size={14} /> Disk-backed history <span className="context-divider" /> Local workspace</span>
          </div>
          {live.status?.listenAll && !archived && <RunningApplicationPicker onListening={setApplicationListening} onAttached={() => {
            changeQuery({ ...defaultQuery(), pageSize: query.pageSize });
            setCursor({ before: null, after: null }); setSelected(null); setPause(null); setFollow(true); setChatOpen(false);
            history.refresh(); live.reconnect();
          }} />}
          <QueryBar query={query} page={activePage} loading={history.loading} error={history.error} searchRef={searchRef}
            maximumId={pause?.maximumId ?? null} onChange={changeQuery} onEdit={condition => openEditor(condition ?? null)}
            onReset={() => { changeQuery({ ...defaultQuery(), pageSize: query.pageSize, sessionId: query.sessionId }, true); setNotice(null); }}
            onNotice={message => setNotice({ message, tone: "info" })} />
          {(live.error || notice) && <div id="notice" className={`notice ${live.error ? "danger" : notice?.tone}`} role={live.error || notice?.tone === "danger" ? "alert" : "status"}>
            <AlertCircle size={15} /><span>{live.error ?? notice?.message}</span>
            {live.error ? <button onClick={live.reconnect}>Reconnect</button> : <button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14} /></button>}
          </div>}
        </div>
        <main id="workspace" className="workspace-region" tabIndex={-1} aria-label="Log exploration workspace">
          {chatOpen && <CopilotChatPanel key={query.sessionId} status={status} sessionId={query.sessionId}
            onClose={() => setChatOpen(false)} returnFocus={() => chatOpener.current?.focus()} />}
          <div className="workspace" data-inspector={inspector} data-fields={fields}>
          <div className="workspace-layout">
          {fields && <DiscoverSidebar page={activePage} onFilter={openEditor} />}
          <LogTable page={activePage} loading={history.loading} error={history.error} selected={visibleSelection}
            matchCase={query.matchCase} follow={follow} wrap={wrap} pageSize={query.pageSize} typography={typography.settings}
            fields={fields} inspector={inspector} onFields={() => setFields(value => !value)}
            onSeverity={levels => changeQuery({ ...query, levels, severity: "all" })}
            onPageSize={pageSize => changeQuery({ ...query, pageSize })}
            onClearSession={() => { setClearError(null); setClearOpen(true); }} clearing={clearing} clearButtonRef={clearOpener}
            onSelect={entry => { setSelected(entry); setInspector(true); }}
            onOlder={() => { const first = activePage?.entries[0]; if (first) { setFollow(false); setCursor({ before: first.id, after: null }); } }}
            onNewer={() => { const last = activePage?.entries.at(-1); if (last) { setFollow(false); setCursor({ before: null, after: last.id }); } }}
            onLive={() => { setFollow(true); setCursor({ before: null, after: null }); }}
            onFollow={value => { setFollow(value); setCursor({ before: value ? null : (status?.lastId ?? 0) + 1, after: null }); }}
            onWrap={setWrap}
            onClear={() => { changeQuery({ ...query, dismissedThrough: status?.lastId ?? 0 }); setSelected(null); setNotice({ tone: "info", message: "Existing entries are hidden in this tab only. Reset restores disk history." }); }}
            onRetry={history.refresh} onInspector={() => setInspector(value => !value)} />
          {inspector && <Inspector entry={visibleSelection} status={status} onClose={() => setInspector(false)}
            onCondition={addCondition} onDraft={openEditor} onNotice={setNotice} />}
          </div>
          </div>
        </main>
        {!archived && !live.status?.listenAll && live.status?.canWriteInput && !live.status.isCompleted && <TerminalInput />}
        <footer className="app-footer"><span id="capacityNote"><HardDrive size={12} /> On disk · {status?.capacity ? `Limit ${NumberFormatter.format(status.capacity)}` : "Unlimited history"}
          <span id="evictedNote">{status?.evictedCount ? ` · ${NumberFormatter.format(status.evictedCount)} expired` : " · Localhost only"}</span></span>
          <span id="runMeta"><Clock3 size={12} /> {Math.floor(elapsed / 60)}m {elapsed % 60}s{status && ` · ${TimeFormatter.format(new Date(status.startedAt))}`}</span></footer>
        <ConditionDialog open={editor.open} conditions={query.conditions} includeMode={query.includeMode} seed={editor.seed}
          returnFocus={() => {
            if (editorOpener.current?.isConnected) editorOpener.current.focus();
            else searchRef.current?.focus();
          }}
          onClose={() => setEditor({ open: false, seed: null })}
          onApply={(conditions, includeMode) => { changeQuery({ ...query, conditions, includeMode }); setEditor({ open: false, seed: null }); }} />
        <ClearHistoryDialog open={clearOpen} deleting={clearing} error={clearError}
          entryCount={Math.max(0, (status?.lastId ?? 0) - (status?.clearedThroughId ?? 0))}
          onClose={() => setClearOpen(false)} onConfirm={clearHistory}
          returnFocus={() => clearOpener.current?.focus()} />
        <SessionsDialog open={sessionsOpen} selected={query.sessionId} onClose={() => setSessionsOpen(false)}
          onRenamed={session => {
            if (session.isCurrent) {
              live.reconnect();
            }

            if (session.isCurrent ? !query.sessionId : query.sessionId === session.id) history.refresh();
          }}
          onDeleted={id => {
            if (query.sessionId === id) {
              setQuery({ ...defaultQuery(), ...filters.restore({ id: "", isCurrent: true }), pageSize: query.pageSize }); setSelected(null); setCursor({ before: null, after: null }); setPause(null); setFollow(true);
            }
            setNotice({ tone: "info", message: "Saved session and its disk files were deleted." });
          }}
          returnFocus={() => sessionsOpener.current?.focus()} onSelect={selectSession} />
        <SessionImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={selectSession}
          returnFocus={() => importOpener.current?.focus()} />
        <SettingsDialog open={settingsOpen} settings={typography.settings} saved={typography.saved}
          appearance={appearance.appearance} onAppearance={appearance.setAppearance}
          onChange={typography.update} onReset={typography.reset} onClose={() => setSettingsOpen(false)}
          returnFocus={() => settingsOpener.current?.focus()} />
      </div>
      </div>
    </Tooltip.Provider>
  );
}

function RunningApplicationPicker({ onAttached, onListening }: { onAttached(): void; onListening(value: boolean): void }) {
  const [state, setState] = useState<RunningApplicationsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (busy) return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function refresh() {
      try {
        const next = await fetchApplications(controller.signal);
        if (!active) return;
        setState(next); setError(null); onListening(next.selected !== null);
      } catch (error) {
        if (active) setError(errorMessage(error));
      } finally {
        if (active) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => { active = false; controller.abort(); if (timer !== null) clearTimeout(timer); };
  }, [busy, retry, onListening]);

  const identity = (app: RunningApplication) => app.groupId ?? `${app.processId}:${app.startedAtTicks}`;
  const processes = (app: RunningApplication) => app.processes ?? [app];
  async function choose(value: string) {
    const application = state?.applications.find(app => identity(app) === value) ??
      (state?.selected && identity(state.selected) === value ? state.selected : null);
    if (!application || busy) return;
    setBusy(true); setSelectionError(null);
    try {
      const next = await selectApplication(application);
      if (!mounted.current) return;
      setState(next); onListening(next.selected !== null);
      const attached = next.selected && identity(next.selected) === identity(application);
      if (next.error && !attached) setSelectionError(next.error);
      if (attached && (!state?.selected || identity(state.selected) !== identity(application))) onAttached();
    } catch (error) {
      if (mounted.current) setSelectionError(errorMessage(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const applications = state?.applications ?? [];
  const selected = state?.selected;
  const choices = selected && !applications.some(app => identity(app) === identity(selected)) ? [selected, ...applications] : applications;
  const term = search.trim().toLocaleLowerCase();
  const filtered = choices.filter(app => identity(app) === (selected && identity(selected)) ||
    [app.name, app.path, ...processes(app).flatMap(process => [process.name, process.path, String(process.processId)])]
      .some(value => value?.toLocaleLowerCase().includes(term)));
  function label(app: RunningApplication) {
    if (!app.groupId) return `${app.name} (PID ${app.processId})`;
    const members = processes(app);
    return `${app.name} (${members.length} ${members.length === 1 ? "process" : "processes"}; PIDs ${members.map(process => process.processId).join(", ")}) — ${app.path ?? "Path unavailable"}`;
  }
  return <section className="application-picker" aria-label="Live application capture">
    <div className="application-picker-controls">
      <input type="search" aria-label="Find running app" placeholder="Find app, path, or PID…" value={search}
        onChange={event => setSearch(event.target.value)} />
      <label htmlFor="runningApplication">Running app</label>
      <select id="runningApplication" value={selected ? identity(selected) : ""} disabled={busy || !state}
        aria-describedby="applicationCaptureHelp" onChange={event => void choose(event.target.value)}>
        <option value="" disabled>{state && applications.length === 0 ? "No running .NET apps found" : "Choose a running app"}</option>
        {filtered.filter(app => !app.isTool).map(app => <option key={identity(app)} value={identity(app)}>{label(app)}</option>)}
        {filtered.some(app => app.isTool) && <optgroup label=".NET tooling">
          {filtered.filter(app => app.isTool).map(app => <option key={identity(app)} value={identity(app)}>{label(app)}</option>)}
        </optgroup>}
        {applications.length > 0 && filtered.length === 0 && <option disabled>No apps match your search</option>}
      </select>
      <button className="ghost-button" disabled={busy} onClick={() => { setSelectionError(null); setRetry(value => value + 1); }}>Refresh apps</button>
      {selected && (selectionError || state?.error) && <button disabled={busy} onClick={() => void choose(identity(selected))}>Retry app</button>}
      <span role="status">{busy ? "Connecting to application…" : selected?.groupId && processes(selected).length === 0 ?
        `Connecting to ${selected.name}…` : selected ?
        `Listening to ${selected.name}${selected.groupId ? ` · ${processes(selected).length} ${processes(selected).length === 1 ? "process" : "processes"}` : ""}` :
        "Waiting for you to choose an app."}</span>
    </div>
    {selected?.groupId && <details className="application-processes">
      <summary>Captured processes · {selected.path ?? "Path unavailable"}</summary>
      <ul>{processes(selected).map(process => <li key={`${process.processId}:${process.startedAtTicks}`}>
        <strong>PID {process.processId}</strong> · {process.name}<span>{process.path ?? "Path unavailable"}</span>
      </li>)}</ul>
    </details>}
    <p id="applicationCaptureHelp" className="muted">Apps are grouped by launch or entrypoint path. Selecting an app captures its processes together and follows new members while the group is running. Merged logs include the PID. Captures new .NET ILogger events only, not existing console output. Each app keeps its own history; switching back restores its captured logs. Only the selected app is captured.</p>
    {(selectionError || error || state?.error) && <p className="notice danger" role="alert">{selectionError ?? error ?? state?.error}</p>}
  </section>;
}
