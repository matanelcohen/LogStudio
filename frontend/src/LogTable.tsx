import * as Menu from "@radix-ui/react-dropdown-menu";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, pointerWithin, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  flexRender, getCoreRowModel, useReactTable,
  type ColumnDef, type ColumnSizingState, type VisibilityState
} from "@tanstack/react-table";
import { AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowRight, ChartNoAxesColumn, Check, ChevronDown, CircleAlert, Columns3, ListFilter, MoreHorizontal, PanelRight, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { MaximumHighlights, NumberFormatter, SeverityLabels, TimeFormatter, type LogEntry, type LogPage, type Severity } from "./model";
import { ColumnHeader } from "./ColumnHeader";
import { PageSizeControl } from "./PageSizeControl";
import { VisiblePageChart } from "./VisiblePageChart";

const DefaultOrder = ["id", "timestamp", "severity", "stream", "category", "message"];
const DefaultVisibility: VisibilityState = { id: false, stream: false };
const MinimumMessageWidth = 240;
const DefaultColumnSizes: Readonly<Record<string, number>> = { id: 60, timestamp: 110, severity: 90, stream: 80, category: 180, message: 600 };
const InitialTableWidth = Object.values(DefaultColumnSizes).reduce((sum, width) => sum + width, 0);

export function Highlight({ message, terms, matchCase }: { message: string; terms: string[]; matchCase: boolean }) {
  const values = terms.filter(Boolean).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!values.length) return message;
  const pattern = new RegExp(values.join("|"), matchCase ? "g" : "gi");
  const fragments: ReactNode[] = [];
  let offset = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null && count++ < MaximumHighlights) {
    fragments.push(message.slice(offset, match.index), <mark key={match.index}>{match[0]}</mark>);
    offset = match.index + match[0].length;
  }
  fragments.push(message.slice(offset));
  return <>{fragments}</>;
}

export function LogTable({ page, loading, error, selected, matchCase, follow, wrap, pageSize, fields, inspector, onFields, onSeverity, onPageSize, onClearSession, clearing, clearButtonRef, onSelect, onOlder, onNewer, onLive, onFollow, onWrap, onClear, onRetry, onInspector }: {
  page: LogPage | null;
  loading: boolean;
  error: string | null;
  selected: LogEntry | null;
  matchCase: boolean;
  follow: boolean;
  wrap: boolean;
  pageSize: number;
  fields: boolean;
  inspector: boolean;
  clearing: boolean;
  clearButtonRef: RefObject<HTMLButtonElement | null>;
  onFields(): void;
  onSeverity(levels: Severity[]): void;
  onPageSize(size: number): void;
  onClearSession(): void;
  onSelect(entry: LogEntry): void;
  onOlder(): void;
  onNewer(): void;
  onLive(): void;
  onFollow(value: boolean): void;
  onWrap(value: boolean): void;
  onClear(): void;
  onRetry(): void;
  onInspector(): void;
}) {
  const [visibility, setVisibility] = useState<VisibilityState>(DefaultVisibility);
  const [sizing, setSizing] = useState<ColumnSizingState>({});
  const [order, setOrder] = useState<string[]>(DefaultOrder);
  const [paneWidth, setPaneWidth] = useState(InitialTableWidth);
  const [timeline, setTimeline] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const emptyEntries = useMemo<LogEntry[]>(() => [], []);
  const entries = page?.entries ?? emptyEntries;
  const metadataWidth = DefaultOrder.filter(id => id !== "message" && visibility[id] !== false)
    .reduce((sum, id) => sum + (sizing[id] ?? DefaultColumnSizes[id] ?? 0), 0);
  const messageWidth = Math.max(MinimumMessageWidth, paneWidth - metadataWidth);
  const columns = useMemo<ColumnDef<LogEntry>[]>(() => [
    { accessorKey: "id", header: "#", size: 60, minSize: 44, cell: info => <span className="sequence">{info.row.original.id}</span> },
    { accessorKey: "timestamp", header: "Captured", size: 110, minSize: 90, cell: info =>
      <span className="timestamp">{TimeFormatter.format(new Date(info.row.original.timestamp))}</span> },
    { accessorKey: "severity", header: "Level", size: 90, minSize: 72, cell: info =>
      <span className={`severity-badge ${info.row.original.severity}`}>{SeverityLabels[info.row.original.severity]}</span> },
    { accessorKey: "stream", header: "Stream", size: 80, minSize: 66, cell: info => <span className="stream-cell">{info.row.original.stream}</span> },
    { accessorKey: "category", header: "Category", size: 180, minSize: 90, cell: info =>
      <span className="category-cell" title={info.row.original.category ?? "Uncategorized"}>{info.row.original.category ?? "—"}</span> },
    { accessorKey: "message", header: "Message", size: messageWidth, minSize: MinimumMessageWidth, enableHiding: false, cell: info =>
      <pre className="message"><Highlight message={info.row.original.message} terms={page?.highlightTerms ?? []} matchCase={matchCase} /></pre> }
  ], [page?.highlightTerms, matchCase, messageWidth]);

  const table = useReactTable({
    data: entries, columns, getCoreRowModel: getCoreRowModel(),
    getRowId: row => String(row.id),
    manualPagination: true, rowCount: page?.matchCount ?? 0,
    columnResizeMode: "onChange",
    state: { columnVisibility: visibility, columnSizing: sizing, columnOrder: order },
    onColumnVisibilityChange: setVisibility, onColumnSizingChange: setSizing, onColumnOrderChange: setOrder
  });

  useEffect(() => {
    if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [entries, follow]);
  useEffect(() => {
    const pane = scroll.current;
    if (!pane) return;
    setPaneWidth(pane.clientWidth);
    const observer = new ResizeObserver(() => setPaneWidth(pane.clientWidth));
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  function moveColumn(id: string, direction: number) {
    const next = [...order];
    const position = next.indexOf(id);
    const target = position + direction;
    const other = next[target];
    if (position < 0 || target < 0 || target >= next.length || other === undefined) return;
    next[target] = id;
    next[position] = other;
    setOrder(next);
  }

  function dropColumn(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const first = order.indexOf(String(event.active.id));
    const last = order.indexOf(String(event.over.id));
    if (first >= 0 && last >= 0) setOrder(arrayMove(order, first, last));
  }

  const first = entries[0];
  const last = entries.at(-1);
  return (
    <section className="log-panel" aria-label="Discover results">
      <div className="panel-header">
        <div className="panel-heading">
          <h2>Logs</h2><span id="matchCount" className="result-count">{error ? "Search failed" : page ? `${NumberFormatter.format(page.matchCount)} ${page.matchCount === page.status.retainedCount ? "entries" : "matching"}` : "Loading…"}</span>
          {page && page.matchCount !== page.status.retainedCount && <span className="captured-count">of <span id="retainedCount">{NumberFormatter.format(page.status.retainedCount)}</span></span>}
          <span className="result-divider" />
          <button className="severity-stat error-stat" title="Show error and critical entries in this query" aria-label="Filter error entries" onClick={() => onSeverity(["error", "critical"])}>
            <CircleAlert size={12} /><span id="errorCount">{NumberFormatter.format(page?.errorCount ?? 0)}</span><span>errors</span>
          </button>
          <button className="severity-stat warning-stat" title="Show warning entries in this query" aria-label="Filter warning entries" onClick={() => onSeverity(["warning"])}>
            <AlertTriangle size={12} /><span id="warningCount">{NumberFormatter.format(page?.warningCount ?? 0)}</span><span>warnings</span>
          </button>
          {loading && page && <span className="query-loading" role="status">Searching…</span>}
        </div>
        <div className="table-tools">
          <button className="view-toggle small" aria-label="Available fields" aria-pressed={fields} onClick={onFields}><ListFilter size={14} />Fields</button>
          <button className="view-toggle small" aria-label="Toggle timeline" aria-pressed={timeline} onClick={() => setTimeline(value => !value)}><ChartNoAxesColumn size={14} />Timeline</button>
          <Menu.Root>
            <Menu.Trigger asChild><button className="small"><Columns3 size={14} /> Columns <ChevronDown size={11} /></button></Menu.Trigger>
            <Menu.Portal><Menu.Content className="menu-content" sideOffset={6} align="end">
              <Menu.Label className="menu-label">Visible columns</Menu.Label>
              {table.getAllLeafColumns().map(column => (
                <Menu.CheckboxItem className="menu-item" key={column.id} checked={column.getIsVisible()} disabled={!column.getCanHide()}
                  onCheckedChange={value => column.toggleVisibility(value)}>
                  <Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator>{column.id === "id" ? "Sequence ID" : typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}
                </Menu.CheckboxItem>
              ))}
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item" onSelect={() => { setSizing({}); setVisibility(DefaultVisibility); setOrder(DefaultOrder); }}><RotateCcw size={13} /> Reset columns</Menu.Item>
            </Menu.Content></Menu.Portal>
          </Menu.Root>
          <button className="view-toggle icon-button" aria-label="Toggle inspector" aria-pressed={inspector} onClick={onInspector}><PanelRight size={15} /></button>
          <button id="clearSession" ref={clearButtonRef} className="icon-button" aria-label="Clear logs" disabled={clearing} onClick={onClearSession}
            title="Delete all session history, not just the current view"><Trash2 size={14} /></button>
          <Menu.Root>
            <Menu.Trigger asChild><button className="icon-button" aria-label="Explorer options"><MoreHorizontal size={17} /></button></Menu.Trigger>
            <Menu.Portal><Menu.Content className="menu-content" sideOffset={6} align="end">
              <Menu.Label className="menu-label">View options</Menu.Label>
              <Menu.CheckboxItem className="menu-item" checked={wrap} onCheckedChange={onWrap}><Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator>Wrap long lines</Menu.CheckboxItem>
              <Menu.CheckboxItem className="menu-item" checked={follow} onCheckedChange={onFollow}><Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator>Follow newest entries</Menu.CheckboxItem>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item" onSelect={onClear}>Clear view (this tab)</Menu.Item>
              <Menu.Item className="menu-item" onSelect={onRetry}>Refresh disk history</Menu.Item>
            </Menu.Content></Menu.Portal>
          </Menu.Root>
        </div>
      </div>
      {timeline && <VisiblePageChart entries={entries} />}
      <div id="logsScroll" ref={scroll} className={`logs-scroll ${wrap ? "wrapped" : ""}`} tabIndex={0} aria-label="Scrollable log entries" aria-busy={loading}>
        <DndContext sensors={sensors} collisionDetection={event => event.pointerCoordinates ? pointerWithin(event) : closestCenter(event)} onDragEnd={dropColumn}>
        <table aria-label="Captured logs" style={{ width: `max(100%, ${table.getTotalSize()}px)` }}>
          <colgroup>{table.getVisibleLeafColumns().map(column => <col key={column.id} style={{ width: column.getSize() }} />)}</colgroup>
          <SortableContext items={table.getVisibleLeafColumns().map(column => column.id)} strategy={horizontalListSortingStrategy}>
          <thead>
            {table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => (
              <ColumnHeader key={header.id} header={header} order={order} onMove={moveColumn}
                onResize={(id, width) => setSizing(value => ({ ...value, [id]: width }))} />
            ))}</tr>)}
          </thead>
          </SortableContext>
          <tbody id="rows" data-loaded-entries={entries.length}>
            {table.getRowModel().rows.map(row => (
              <tr key={row.id} data-log-id={row.id} tabIndex={0} className={selected?.id === row.original.id ? "selected" : ""}
                onClick={() => onSelect(row.original)} onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.original); }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const target = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
                    if (target instanceof HTMLElement) target.focus();
                  }
                }}>
                {row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        </DndContext>
        {entries.length === 0 && <div id="emptyState" className="empty-state">
          <Search size={28} />
          <h3>{error ? "Couldn’t load history" : loading ? "Searching disk history…" : page?.status.retainedCount ? "No matching entries" : "Waiting for output"}</h3>
          <p>{error ?? (loading ? "Only the current page is loaded into memory." : "Change your query or conditions. Reset restores entries hidden by Clear view.")}</p>
          {error && <button onClick={onRetry}>Retry request</button>}
        </div>}
      </div>
      <div className="panel-footer">
        <span id="rangeSummary">{loading ? "Searching disk history…" : first && last ? `#${first.id}–${last.id} · ${entries.length} of ${NumberFormatter.format(page?.matchCount ?? 0)} matches` : "No matching entries"}</span>
        <div className="paging">
          <PageSizeControl value={pageSize} onChange={onPageSize} />
          <button id="older" className="small" disabled={loading || !first || !page?.olderCount} onClick={onOlder}><ArrowLeft size={13} /> Older</button>
          <button id="newer" className="small" disabled={loading || !last || !page?.newerCount} onClick={onNewer}>Newer <ArrowRight size={13} /></button>
          {!follow && <button id="jumpLive" className="small" onClick={onLive}><ArrowDownToLine size={13} /> Latest {page?.newerCount ? `(${NumberFormatter.format(page.newerCount)})` : ""}</button>}
        </div>
      </div>
    </section>
  );
}
