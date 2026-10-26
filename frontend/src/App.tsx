import * as Oui from "@opensearch-project/oui";

import { AlertCircle, ChevronDown, ChevronRight, Clock3, Compass, Database, FileUp, HardDrive, History, Logs, MessageSquare, Monitor, Moon, Pause, Play, Settings, Sun, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ConditionDialog } from "./ConditionDialog";
import { ClearHistoryDialog } from "./ClearHistoryDialog";
import { SessionsDialog } from "./SessionsDialog";
import { SessionImportDialog } from "./SessionImportDialog";
import { SavedSearchesDialog } from "./SavedSearchesDialog";
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
import { AppearanceChoices, AppearanceOptions } from "./themes";
import { useAppearance } from "./useAppearance";
import { useTypography } from "./useTypography";
import { useLiveStatus, useLogPage } from "./useLogExplorer";
import { useSessionFilters } from "./useSessionFilters";
import { useAppUpdate } from "./useAppUpdate";
import { usePreferences } from "./usePreferences";
import { DefaultTypography, type ExplorerPreferences } from "./preferences";

interface PauseSnapshot { maximumId: number; status: ViewerStatus | null; }

export default function App() {
  const [query, setQuery] = useState<QueryState>(defaultQuery);
  const [cursor, setCursor] = useState<PageCursor>({ before: null, after: null });
  const [pause, setPause] = useState<PauseSnapshot | null>(null);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; seed: LogCondition | null }>({ open: false, seed: null });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savedSearchesOpen, setSavedSearchesOpen] = useState(false);
  const savedSearchesOpener = useRef<HTMLElement | null>(null);
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
  const preferences = usePreferences();
  const { typography, explorer } = preferences.settings;
  const { wrap, inspector, fields } = explorer;
  const updateExplorer = (changes: Partial<ExplorerPreferences>) => preferences.update({ explorer: changes });
  const setInspector = (value: boolean) => updateExplorer({ inspector: value });
  const appearance = useAppearance(preferences.settings.appearance, appearance => preferences.update({ appearance }));
  useTypography(typography);
  const updates = useAppUpdate();
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
    setQuery(query => query.pageSize === explorer.pageSize ? query : { ...query, pageSize: explorer.pageSize });
  }, [explorer.pageSize]);
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
    if (query.pageSize !== explorer.pageSize) updateExplorer({ pageSize: query.pageSize });
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
  const switchingHistory = !archived && !!historyDirectory && !!activePage && activePage.status.historyDirectory !== historyDirectory;
  const connectionLabel = live.connection === "live" ? "Connected" : live.connection === "paused" ? "Paused" :
    live.connection === "reconnecting" ? "Reconnecting" : live.connection === "failed" ? "Disconnected" : "Connecting";
  const elapsed = status ? Math.max(0, Math.floor(((status.completedAt ? Date.parse(status.completedAt) : now) - Date.parse(status.startedAt)) / 1000)) : 0;

  return (
    <Oui.TooltipProvider delayDuration={400}>
      <div className="discover-shell">
        <a className="skip-link" href="#workspace">Skip to log results</a>
        <nav className="discover-rail" aria-label="Workspace applications">
          <div className="rail-brand" aria-hidden="true"><span className="rail-brand-icon"><Logs size={21} /></span><span className="rail-wordmark">Log Studio</span></div>
          <span className="rail-label" aria-hidden="true">Workspace</span>
          <Oui.Button variant="ghost" size="sm" className="rail-item active" aria-label="Discover logs" aria-current="page" title="Discover logs" onClick={() => searchRef.current?.focus()}><Compass size={20} /><span>Discover</span></Oui.Button>
          <Oui.Button variant="ghost" size="sm" className="rail-item" aria-label="Browse sessions" title="Sessions" onClick={() => setSessionsOpen(true)}><History size={20} /><span>Sessions</span></Oui.Button>
          <div className="rail-footer"><Monitor size={17} aria-hidden="true" /><div><strong>On this device</strong><span>Local workspace</span></div></div>
        </nav>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <h1>Log Studio</h1><ChevronRight size={14} className="breadcrumb-separator" />
            <Oui.Button variant="outline" size="sm" id="sessions" className="session-switcher" ref={sessionsOpener} aria-label="Sessions" onClick={() => setSessionsOpen(true)}>
              <History size={14} /><span id="applicationName">{status?.applicationName ?? "Select a session"}</span><ChevronDown size={12} />
            </Oui.Button>
            <Oui.Badge variant="outline" id="runStatus" className={`run-state-badge ${status?.isCompleted ? status.exitCode ? "failed" : "finished" : "running"}`}>
              {archived ? "Saved" : status?.isCompleted ? status.exitCode ? `Exit ${status.exitCode}` : "Finished" :
                status?.listenAll ? applicationListening ? "Listening" : "Choose an app" : status ? "Running" : "Connecting"}
            </Oui.Badge>
          </div>
          <div className="header-actions">
            {(updates.state?.updateAvailable || updates.state?.installedVersion || updates.error) && <Oui.Button variant="ghost" size="sm" className="ghost-button"
              onClick={() => setSettingsOpen(true)}>{updates.state?.installedVersion ? "Restart required" : updates.error ? "Update check failed" : "Update available"}</Oui.Button>}
            <span id="connection" className={`connection ${live.connection}`} role="status">{archived ? "Saved session" : connectionLabel}</span>
            <Oui.Button variant="ghost" size="sm" id="importLogs" ref={importOpener} className="ghost-button" onClick={() => setImportOpen(true)}><FileUp size={14} /> Import</Oui.Button>
            <Oui.Button variant="ghost" size="sm" ref={chatOpener} className="ghost-button" aria-pressed={chatOpen} disabled={!status}
              onClick={() => setChatOpen(true)}><MessageSquare size={14} /> Ask Copilot</Oui.Button>
            <Oui.Popover>
              <Oui.PopoverTrigger asChild><Oui.Button variant="ghost" size="icon" id="storageInfo" className="icon-button ghost-button" aria-label="Storage details"><HardDrive size={15} /></Oui.Button></Oui.PopoverTrigger>
              <Oui.PopoverContent className="popover storage-popover" sideOffset={8} align="end">
                <h3><Database size={16} /> Temporary disk history</h3>
                <p>All retained entries stay on disk. The browser caches one {query.pageSize}-entry page.</p>
                <dl><dt>Journal + index</dt><dd>{NumberFormatter.format(status?.journalBytes ?? 0)} bytes</dd>
                  <dt>Write buffers</dt><dd>{NumberFormatter.format(status?.ioBufferBytes ?? 0)} bytes</dd>
                  <dt>Flush cadence</dt><dd>Every {NumberFormatter.format(status?.flushEveryEntries ?? 0)} entries, or before reads</dd></dl>
                <pre>{status?.historyDirectory ?? "Waiting for storage details…"}</pre>
                <p className="muted">Run histories are owner-private. The wrapper saves completed sessions for reopening; temporary capture files are removed on graceful close.</p>
                <a href="third-party-notices.txt" target="_blank" rel="noreferrer">Third-party component licenses</a>
              </Oui.PopoverContent>
            </Oui.Popover>
            <Hint label={pause ? "Resume live updates and catch up from disk." : "Freeze this tab. The command keeps capturing."}>
              <Oui.Button variant="outline" size="sm" id="pause" className={pause ? "paused-control" : "ghost-button"} disabled={archived} onClick={() => setPause(pause ? null : { maximumId: status?.lastId ?? 0, status })}>
                {pause ? <Play size={14} /> : <Pause size={14} />}{pause ? "Resume" : "Pause"}
              </Oui.Button>
            </Hint>
            <Oui.DropdownMenu>
              <Oui.DropdownMenuTrigger asChild><Oui.Button variant="ghost" size="icon" id="theme" className="icon-button ghost-button" aria-label="Appearance">{appearance.theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}</Oui.Button></Oui.DropdownMenuTrigger>
              <Oui.DropdownMenuContent className="menu-content" sideOffset={7} align="end">
                <Oui.DropdownMenuLabel className="menu-label">Color theme</Oui.DropdownMenuLabel>
                <Oui.DropdownMenuRadioGroup value={appearance.appearance} onValueChange={value => appearance.setAppearance(readChoice(value, AppearanceChoices))}>
                  {AppearanceOptions.map(option => <Oui.DropdownMenuRadioItem value={option.value} className="menu-item" key={option.value}>
                    {option.scheme === "system" ? <Monitor size={14} /> : option.scheme === "light" ? <Sun size={14} /> : <Moon size={14} />}
                    {option.label}
                  </Oui.DropdownMenuRadioItem>)}
                </Oui.DropdownMenuRadioGroup>
              </Oui.DropdownMenuContent>
            </Oui.DropdownMenu>
            <Oui.Button variant="ghost" size="icon" ref={settingsOpener} className="icon-button ghost-button" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={15} /></Oui.Button>
          </div>
        </header>
        <div className="query-region">
          <div className="workspace-heading">
            <div><span className="workspace-kicker">LOG EXPLORER</span><h2>Discover</h2><p>Search, filter, and inspect your session history.</p></div>
          </div>
          {live.status?.listenAll && !archived && <RunningApplicationPicker onListening={setApplicationListening} onAttached={() => {
            // The first attachment reuses the waiting history; later switches reset through the live status.
            if (applicationListening) return;
            changeQuery({ ...defaultQuery(), pageSize: query.pageSize });
            setCursor({ before: null, after: null }); setSelected(null); setPause(null); setFollow(true); setChatOpen(false);
          }} />}
          <QueryBar query={query} page={switchingHistory ? null : activePage} loading={history.loading} error={history.error} searchRef={searchRef}
            onSavedSearches={() => { savedSearchesOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSavedSearchesOpen(true); }}
            maximumId={pause?.maximumId ?? null} onChange={changeQuery} onEdit={condition => openEditor(condition ?? null)}
            onReset={() => { changeQuery({ ...defaultQuery(), pageSize: query.pageSize, sessionId: query.sessionId }, true); setNotice(null); }}
            onNotice={message => setNotice({ message, tone: "info" })} />
          {preferences.error && <Oui.Alert variant="default" className="notice warning" role="alert">
            <AlertCircle size={15} /><span>{preferences.error} Changes still apply in this tab.</span>
            <Oui.Button variant="outline" size="sm" onClick={preferences.retry}>Retry settings</Oui.Button>
          </Oui.Alert>}
          {(live.error || notice) && <Oui.Alert variant={live.error || notice?.tone === "danger" ? "destructive" : "default"} id="notice" className={`notice ${live.error ? "danger" : notice?.tone}`} role={live.error || notice?.tone === "danger" ? "alert" : "status"}>
            <AlertCircle size={15} /><span>{live.error ?? notice?.message}</span>
            {live.error ? <Oui.Button variant="outline" size="sm" onClick={live.reconnect}>Reconnect</Oui.Button> : <Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14} /></Oui.Button>}
          </Oui.Alert>}
        </div>
        <main id="workspace" className="workspace-region" tabIndex={-1} aria-label="Log exploration workspace">
          {chatOpen && <CopilotChatPanel key={query.sessionId} status={status} sessionId={query.sessionId}
            onClose={() => setChatOpen(false)} returnFocus={() => chatOpener.current?.focus()} />}
          <Oui.Card className="workspace" data-inspector={inspector} data-fields={fields} aria-busy={switchingHistory}>
          {switchingHistory && <div className="history-switch-status" role="status">Loading selected application history…</div>}
          <div className="workspace-layout" inert={switchingHistory}>
          {fields && <DiscoverSidebar page={activePage} onFilter={openEditor} />}
          <LogTable page={activePage} loading={history.loading} error={history.error} selected={visibleSelection}
            matchCase={query.matchCase} follow={follow} wrap={wrap} pageSize={query.pageSize} typography={typography}
            preferences={explorer} onPreferences={updateExplorer}
            fields={fields} inspector={inspector} onFields={() => updateExplorer({ fields: !fields })}
            onSeverity={levels => changeQuery({ ...query, levels, severity: "all" })}
            onPageSize={pageSize => changeQuery({ ...query, pageSize })}
            onClearSession={() => { setClearError(null); setClearOpen(true); }} clearing={clearing} clearButtonRef={clearOpener}
            onSelect={entry => { setSelected(entry); setInspector(true); }}
            onOlder={() => { const first = activePage?.entries[0]; if (first) { setFollow(false); setCursor({ before: first.id, after: null }); } }}
            onNewer={() => { const last = activePage?.entries.at(-1); if (last) { setFollow(false); setCursor({ before: null, after: last.id }); } }}
            onLive={() => { setFollow(true); setCursor({ before: null, after: null }); }}
            onFollow={value => { setFollow(value); setCursor({ before: value ? null : (status?.lastId ?? 0) + 1, after: null }); }}
            onWrap={wrap => updateExplorer({ wrap })}
            onClear={() => { changeQuery({ ...query, dismissedThrough: status?.lastId ?? 0 }); setSelected(null); setNotice({ tone: "info", message: "Existing entries are hidden in this tab only. Reset restores disk history." }); }}
            onRetry={history.refresh} onInspector={() => setInspector(!inspector)} />
          {inspector && <Inspector entry={visibleSelection} entries={activePage?.entries ?? []} status={status} onSelect={setSelected} onClose={() => setInspector(false)}
            onCondition={addCondition} onDraft={openEditor} onNotice={setNotice} />}
          </div>
          </Oui.Card>
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
        <SettingsDialog open={settingsOpen} settings={typography} saved={preferences.saved} error={preferences.error} updates={updates}
          appearance={appearance.appearance} onAppearance={appearance.setAppearance}
          onChange={changes => preferences.update({ typography: changes })}
          onReset={() => preferences.update({ typography: { ...DefaultTypography } })} onClose={() => setSettingsOpen(false)}
          returnFocus={() => settingsOpener.current?.focus()} />
        <SavedSearchesDialog open={savedSearchesOpen} query={query} searches={preferences.settings.savedSearches}
          saved={preferences.saved} saveError={preferences.error} onRetry={preferences.retry}
          onChange={savedSearches => preferences.update({ savedSearches })}
          onApply={filters => changeQuery({ ...query, ...filters, dismissedThrough: 0 }, true)}
          onClose={() => setSavedSearchesOpen(false)} returnFocus={() => {
            if (savedSearchesOpener.current?.isConnected) savedSearchesOpener.current.focus();
            else searchRef.current?.focus();
          }} />
      </div>
      </div>
    </Oui.TooltipProvider>
  );
}

function RunningApplicationPicker({ onAttached, onListening }: { onAttached(): void; onListening(value: boolean): void }) {
  const [state, setState] = useState<RunningApplicationsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const mounted = useRef(true);
  const optionId = useId();

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
  }, [busy, onListening]);

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
  function label(app: RunningApplication) {
    if (!app.groupId) return `${app.name} (PID ${app.processId})`;
    const members = processes(app);
    return `${app.name} (${members.length} ${members.length === 1 ? "process" : "processes"}; PIDs ${members.map(process => process.processId).join(", ")}) — ${app.path ?? "Path unavailable"}`;
  }
  function option(app: RunningApplication) {
    const members = processes(app);
    const descriptionId = `${optionId}-${app.processId}-${app.startedAtTicks}`;
    const labelId = `${descriptionId}-label`;
    return <Oui.SelectItem key={identity(app)} value={identity(app)} textValue={app.name} className="select-item" aria-labelledby={labelId} aria-describedby={descriptionId} title={label(app)}>
      <span className="application-select-option">
        <span id={labelId}>{applicationLabel(app)}</span>
        <span id={descriptionId} className="application-option-details">{app.path ?? "Path unavailable"}{app.groupId && ` · PIDs ${members.map(process => process.processId).join(", ")}`}</span>
      </span>

    </Oui.SelectItem>;
  }
  function applicationLabel(app: RunningApplication) {
    const members = processes(app);
    return app.groupId ? `${app.name} · ${members.length} ${members.length === 1 ? "process" : "processes"}` : `${app.name} (PID ${app.processId})`;
  }
  return <section className="application-picker" aria-label="Live application capture">
    <div className="application-picker-controls">
      <label htmlFor="runningApplication">Running app</label>
      <Oui.Select value={selected ? identity(selected) : ""} disabled={busy || !state} onValueChange={value => void choose(value)}>
        <Oui.SelectTrigger id="runningApplication" className="select-trigger" aria-label="Running app" aria-describedby="applicationCaptureHelp">
          <Oui.SelectValue placeholder={state && applications.length === 0 ? "No running .NET apps found" : "Choose a running app"}>{selected ? applicationLabel(selected) : undefined}</Oui.SelectValue>

        </Oui.SelectTrigger>

          <Oui.SelectContent className="select-content application-select-content" position="popper" sideOffset={5} collisionPadding={12}>

              {choices.filter(app => !app.isTool).map(option)}
              {choices.some(app => app.isTool) && <Oui.SelectGroup>
                <Oui.SelectLabel className="menu-label">.NET tooling</Oui.SelectLabel>
                {choices.filter(app => app.isTool).map(option)}
              </Oui.SelectGroup>}
              {choices.length === 0 && <div className="menu-label">No running .NET apps found</div>}

          </Oui.SelectContent>

      </Oui.Select>
      {selected && (selectionError || state?.error) && <Oui.Button variant="outline" size="sm" disabled={busy} onClick={() => void choose(identity(selected))}>Retry app</Oui.Button>}
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
    {(selectionError || error || state?.error) && <Oui.Alert variant="destructive" className="notice danger" role="alert">{selectionError ?? error ?? state?.error}</Oui.Alert>}
  </section>;
}
