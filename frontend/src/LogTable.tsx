import * as Oui from "@opensearch-project/oui";

import { closestCenter, DndContext, KeyboardSensor, PointerSensor, pointerWithin, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  flexRender, getCoreRowModel, useReactTable,
  type ColumnDef, type ColumnSizingState, type VisibilityState
} from "@tanstack/react-table";
import { AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowRight, ChartNoAxesColumn, ChevronDown, CircleAlert, Columns3, ListFilter, MoreHorizontal, PanelRight, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { MaximumHighlights, NumberFormatter, SeverityLabels, TimeFormatter, type LogEntry, type LogPage, type Severity } from "./model";
import { ColumnHeader } from "./ColumnHeader";
import { PageSizeControl } from "./PageSizeControl";
import { VisiblePageChart } from "./VisiblePageChart";
import type { TypographySettings } from "./useTypography";
import { DefaultColumnOrder, DefaultColumnVisibility, type ExplorerPreferences } from "./preferences";

const DefaultOrder = DefaultColumnOrder;
const DefaultVisibility = DefaultColumnVisibility;
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

export function LogTable({ page, loading, error, selected, matchCase, follow, wrap, pageSize, typography, preferences, onPreferences, fields, inspector, onFields, onSeverity, onPageSize, onClearSession, clearing, clearButtonRef, onSelect, onOlder, onNewer, onLive, onFollow, onWrap, onClear, onRetry, onInspector }: {
  page: LogPage | null;
  loading: boolean;
  error: string | null;
  selected: LogEntry | null;
  matchCase: boolean;
  follow: boolean;
  wrap: boolean;
  pageSize: number;
  typography: TypographySettings;
  preferences: ExplorerPreferences;
  onPreferences(changes: Partial<ExplorerPreferences>): void;
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
  const { columnVisibility: visibility, columnSizing: sizing, columnOrder: order, timeline } = preferences;
  const setVisibility = (value: VisibilityState | ((current: VisibilityState) => VisibilityState)) =>
    onPreferences({ columnVisibility: typeof value === "function" ? value(visibility) : value });
  const setSizing = (value: ColumnSizingState | ((current: ColumnSizingState) => ColumnSizingState)) =>
    onPreferences({ columnSizing: typeof value === "function" ? value(sizing) : value });
  const setOrder = (value: string[] | ((current: string[]) => string[])) =>
    onPreferences({ columnOrder: typeof value === "function" ? value(order) : value });
  const [paneWidth, setPaneWidth] = useState(InitialTableWidth);
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
      <Oui.Badge variant="outline" className={`severity-badge ${info.row.original.severity}`}>{SeverityLabels[info.row.original.severity]}</Oui.Badge> },
    { accessorKey: "stream", header: "Stream", size: 80, minSize: 66, cell: info => <span className="stream-cell">{info.row.original.stream}</span> },
    { accessorKey: "category", header: "Category", size: 180, minSize: 90, cell: info =>
      <span className="category-cell" title={info.row.original.category ?? "Uncategorized"}>{info.row.original.category ?? "—"}</span> },
    { accessorKey: "message", header: "Message", size: messageWidth, minSize: MinimumMessageWidth, enableHiding: false, cell: info => {
      const message = info.row.original.message;
      const extraLines = message.match(/\r\n|\r|\n/g)?.length ?? 0;
      const lineLabel = extraLines === 1 ? "line" : "lines";
      const lineHint = `${NumberFormatter.format(extraLines)} additional ${lineLabel}. Select this row to inspect the full message.`;
      return <div className="message-preview">
        <pre className="message"><Highlight message={message} terms={page?.highlightTerms ?? []} matchCase={matchCase} /></pre>
        {!wrap && extraLines > 0 && <span className="message-lines" title={lineHint}>
          <span aria-hidden="true">+{NumberFormatter.format(extraLines)} {lineLabel}</span>
          <span className="visually-hidden">{lineHint}</span>
        </span>}
      </div>;
    } }
  ], [page?.highlightTerms, matchCase, messageWidth, wrap]);

  const table = useReactTable({
    data: entries, columns, getCoreRowModel: getCoreRowModel(),
    defaultColumn: { maxSize: 4000 },
    getRowId: row => String(row.id),
    manualPagination: true, rowCount: page?.matchCount ?? 0,
    columnResizeMode: "onChange",
    state: { columnVisibility: visibility, columnSizing: sizing, columnOrder: order },
    onColumnVisibilityChange: setVisibility, onColumnSizingChange: setSizing, onColumnOrderChange: setOrder
  });

  useEffect(() => {
    if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [entries, follow, typography]);
  useEffect(() => {
    const pane = scroll.current;
    const row = selected && pane?.querySelector(`[data-log-id="${selected.id}"]`);
    if (!pane || !row) return;
    const bounds = pane.getBoundingClientRect();
    const entryBounds = row.getBoundingClientRect();
    const top = bounds.top + (pane.querySelector("thead")?.getBoundingClientRect().height ?? 0);
    if (entryBounds.top < top) pane.scrollTop += entryBounds.top - top;
    else if (entryBounds.bottom > bounds.bottom) pane.scrollTop += entryBounds.bottom - bounds.bottom;
  }, [selected?.id]);
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
          <Oui.Button variant="ghost" size="sm" className="severity-stat error-stat" title="Show error and critical entries in this query" aria-label="Filter error entries" onClick={() => onSeverity(["error", "critical"])}>
            <CircleAlert size={12} /><span id="errorCount">{NumberFormatter.format(page?.errorCount ?? 0)}</span><span>errors</span>
          </Oui.Button>
          <Oui.Button variant="ghost" size="sm" className="severity-stat warning-stat" title="Show warning entries in this query" aria-label="Filter warning entries" onClick={() => onSeverity(["warning"])}>
            <AlertTriangle size={12} /><span id="warningCount">{NumberFormatter.format(page?.warningCount ?? 0)}</span><span>warnings</span>
          </Oui.Button>
          {loading && page && <span className="query-loading" role="status">Searching…</span>}
        </div>
        <div className="table-tools">
          <Oui.Button variant="outline" size="sm" className="view-toggle small" aria-label="Available fields" aria-pressed={fields} onClick={onFields}><ListFilter size={14} />Fields</Oui.Button>
          <Oui.Button variant="outline" size="sm" className="view-toggle small" aria-label="Toggle timeline" aria-pressed={timeline} onClick={() => onPreferences({ timeline: !timeline })}><ChartNoAxesColumn size={14} />Timeline</Oui.Button>
          <Oui.DropdownMenu>
            <Oui.DropdownMenuTrigger asChild><Oui.Button variant="outline" size="sm" className="small"><Columns3 size={14} /> Columns <ChevronDown size={11} /></Oui.Button></Oui.DropdownMenuTrigger>
            <Oui.DropdownMenuContent className="menu-content" sideOffset={6} align="end">
              <Oui.DropdownMenuLabel className="menu-label">Visible columns</Oui.DropdownMenuLabel>
              {table.getAllLeafColumns().map(column => (
                <Oui.DropdownMenuCheckboxItem className="menu-item" key={column.id} checked={column.getIsVisible()} disabled={!column.getCanHide()}
                  onCheckedChange={value => column.toggleVisibility(value)}>
                  {column.id === "id" ? "Sequence ID" : typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}
                </Oui.DropdownMenuCheckboxItem>
              ))}
              <Oui.DropdownMenuSeparator className="menu-separator" />
              <Oui.DropdownMenuItem className="menu-item" onSelect={() => onPreferences({ columnSizing: {}, columnVisibility: DefaultVisibility, columnOrder: DefaultOrder })}><RotateCcw size={13} /> Reset columns</Oui.DropdownMenuItem>
            </Oui.DropdownMenuContent>
          </Oui.DropdownMenu>
          <Oui.Button variant="ghost" size="icon" className="view-toggle icon-button" aria-label="Toggle inspector" aria-pressed={inspector} onClick={onInspector}><PanelRight size={15} /></Oui.Button>
          <Oui.Button variant="ghost" size="icon" id="clearSession" ref={clearButtonRef} className="icon-button" aria-label="Clear logs" disabled={clearing} onClick={onClearSession}
            title="Delete all session history, not just the current view"><Trash2 size={14} /></Oui.Button>
          <Oui.DropdownMenu>
            <Oui.DropdownMenuTrigger asChild><Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Explorer options"><MoreHorizontal size={17} /></Oui.Button></Oui.DropdownMenuTrigger>
            <Oui.DropdownMenuContent className="menu-content" sideOffset={6} align="end">
              <Oui.DropdownMenuLabel className="menu-label">View options</Oui.DropdownMenuLabel>
              <Oui.DropdownMenuCheckboxItem className="menu-item" checked={wrap} onCheckedChange={onWrap}>Wrap long lines</Oui.DropdownMenuCheckboxItem>
              <Oui.DropdownMenuCheckboxItem className="menu-item" checked={follow} onCheckedChange={onFollow}>Follow newest entries</Oui.DropdownMenuCheckboxItem>
              <Oui.DropdownMenuSeparator className="menu-separator" />
              <Oui.DropdownMenuItem className="menu-item" onSelect={onClear}>Clear view (this tab)</Oui.DropdownMenuItem>
              <Oui.DropdownMenuItem className="menu-item" onSelect={onRetry}>Refresh disk history</Oui.DropdownMenuItem>
            </Oui.DropdownMenuContent>
          </Oui.DropdownMenu>
        </div>
      </div>
      {timeline && <VisiblePageChart entries={entries} />}
      <div id="logsScroll" ref={scroll} className={`logs-scroll ${wrap ? "wrapped" : ""}`} tabIndex={0} aria-label="Scrollable log entries" aria-busy={loading}>
        <DndContext sensors={sensors} collisionDetection={event => event.pointerCoordinates ? pointerWithin(event) : closestCenter(event)} onDragEnd={dropColumn}>
        <Oui.Table aria-label="Captured logs" style={{ width: `max(100%, ${table.getTotalSize()}px)` }}>
          <colgroup>{table.getVisibleLeafColumns().map(column => <col key={column.id} style={{ width: column.getSize() }} />)}</colgroup>
          <SortableContext items={table.getVisibleLeafColumns().map(column => column.id)} strategy={horizontalListSortingStrategy}>
          <Oui.TableHeader>
            {table.getHeaderGroups().map(group => <Oui.TableRow key={group.id}>{group.headers.map(header => (
              <ColumnHeader key={header.id} header={header} order={order} onMove={moveColumn}
                onResize={(id, width) => setSizing(value => ({ ...value, [id]: width }))} />
            ))}</Oui.TableRow>)}
          </Oui.TableHeader>
          </SortableContext>
          <Oui.TableBody id="rows" data-loaded-entries={entries.length}>
            {table.getRowModel().rows.map(row => (
              <Oui.TableRow key={row.id} data-log-id={row.id} data-severity={row.original.severity} tabIndex={0} aria-selected={selected?.id === row.original.id} className={selected?.id === row.original.id ? "selected" : ""}
                onClick={() => onSelect(row.original)} onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.original); }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const target = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
                    if (target instanceof HTMLElement) target.focus();
                  }
                }}>
                {row.getVisibleCells().map(cell => <Oui.TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Oui.TableCell>)}
              </Oui.TableRow>
            ))}
          </Oui.TableBody>
        </Oui.Table>
        </DndContext>
        {entries.length === 0 && <div id="emptyState" className="empty-state">
          <Search size={28} />
          <h3>{error ? "Couldn’t load history" : loading ? "Searching disk history…" : page?.status.retainedCount ? "No matching entries" : "Waiting for output"}</h3>
          <p>{error ?? (loading ? "Only the current page is loaded into memory." : "Change your query or conditions. Reset restores entries hidden by Clear view.")}</p>
          {error && <Oui.Button variant="outline" size="sm" onClick={onRetry}>Retry request</Oui.Button>}
        </div>}
      </div>
      <div className="panel-footer">
        <span id="rangeSummary">{loading ? "Searching disk history…" : first && last ? `#${first.id}–${last.id} · ${entries.length} of ${NumberFormatter.format(page?.matchCount ?? 0)} matches` : "No matching entries"}</span>
        <div className="paging">
          <PageSizeControl value={pageSize} onChange={onPageSize} />
          <Oui.Button variant="outline" size="sm" id="older" className="small" disabled={loading || !first || !page?.olderCount} onClick={onOlder}><ArrowLeft size={13} /> Older</Oui.Button>
          <Oui.Button variant="outline" size="sm" id="newer" className="small" disabled={loading || !last || !page?.newerCount} onClick={onNewer}>Newer <ArrowRight size={13} /></Oui.Button>
          {!follow && <Oui.Button variant="outline" size="sm" id="jumpLive" className="small" onClick={onLive}><ArrowDownToLine size={13} /> Latest {page?.newerCount ? `(${NumberFormatter.format(page.newerCount)})` : ""}</Oui.Button>}
        </div>
      </div>
    </section>
  );
}
