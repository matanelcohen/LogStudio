import * as Popover from "@radix-ui/react-popover";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, CircleHelp, Download, FileArchive, Filter, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import type { RefObject } from "react";
import {
  buildExportUrl, buildSessionExportUrl, FieldLabels, NumberFormatter, OperatorLabels, Streams,
  type LogCondition, type LogPage, type QueryState
} from "./model";
import { SelectControl, type Choice } from "./ui";
import { LevelFilter } from "./LevelFilter";

const TimeChoices: Choice[] = [
  { value: "0", label: "All history" }, { value: "60000", label: "Last minute" },
  { value: "300000", label: "Last 5 minutes" }, { value: "900000", label: "Last 15 minutes" }
];

function categoryLabel(value: string): string {
  const category: unknown = JSON.parse(value);
  if (category === null) return "Uncategorized";
  if (typeof category !== "string") throw new Error("The category control contains an invalid value.");
  return category;
}

export function QueryBar({ query, page, loading, error, searchRef, maximumId, onChange, onEdit, onReset, onNotice }: {
  query: QueryState;
  page: LogPage | null;
  loading: boolean;
  error: string | null;
  searchRef: RefObject<HTMLInputElement | null>;
  maximumId: number | null;
  onChange(query: QueryState): void;
  onEdit(condition?: LogCondition): void;
  onReset(): void;
  onNotice(message: string): void;
}) {
  const categories: Choice[] = [
    { value: "", label: "All categories" },
    ...(page?.categories ?? []).map(category => ({ value: JSON.stringify(category), label: category ?? "Uncategorized" }))
  ];
  if (query.category && !categories.some(category => category.value === query.category))
    categories.push({ value: query.category, label: categoryLabel(query.category) });
  const shortcut = navigator.platform.startsWith("Mac") ? "⌘ K" : "Ctrl+K";
  const exportId = Math.min(maximumId ?? page?.status.lastId ?? 0, page?.status.lastId ?? 0);

  return (
    <section className="query-bar" aria-label="Search and filter logs">
      <div className="search-row">
        <div className="search-box">
          <Search size={16} aria-hidden />
          <input id="search" aria-label="Search logs" ref={searchRef} type="search" value={query.search}
            maxLength={1024} autoComplete="off" spellCheck={false} aria-invalid={!!error}
            placeholder='Search history: "exact phrases", -exclude, category:Name…'
            onChange={event => onChange({ ...query, search: event.target.value })} />
          <kbd>{shortcut}</kbd>
        </div>
        <button id="conditionsButton" className="query-builder-button" onClick={() => onEdit()}>
          <SlidersHorizontal size={15} /> Add filter {query.conditions.length > 0 && <span className="button-count">{query.conditions.length}</span>}
        </button>
        <Popover.Root>
          <Popover.Trigger asChild><button className="icon-button" aria-label="Search help"><CircleHelp size={17} /></button></Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="popover search-help" sideOffset={8} align="end">
              <h3>Query guide</h3>
              <p>Search terms are literal and AND-ed. Use quoted phrases and <code>-term</code> to exclude.</p>
              <p>Scope terms with <code>category:</code>, <code>level:</code>, <code>stream:</code>, <code>message:</code>, or exact <code>id:</code>.</p>
              <p>The condition builder adds field operators and opt-in regex. Includes support AND / OR; exclusions always win.</p>
              <p className="muted">Only the current page is loaded in memory. Queries and exports read the full disk history.</p>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <div className="export-actions">
        <a id="download" className={`button primary ${!page?.matchCount || loading || error ? "disabled" : ""}`}
          aria-disabled={!page?.matchCount || loading || !!error}
          href={buildExportUrl(query, exportId)} download={`log-studio-${Date.now()}.jsonl`}
          onClick={event => {
            if (!page?.matchCount || loading || error) event.preventDefault();
            else onNotice(`Streaming export requested for ${NumberFormatter.format(page.matchCount)} matching entries.`);
          }}><Download size={14} /> Export</a>
        <Menu.Root>
          <Menu.Trigger asChild><button className="primary export-menu-button" aria-label="Export options"><ChevronDown size={13} /></button></Menu.Trigger>
          <Menu.Portal><Menu.Content className="menu-content export-menu" sideOffset={6} align="end">
            <Menu.Label className="menu-label">Export selected session</Menu.Label>
            <Menu.Item className="menu-item" asChild><a href={buildSessionExportUrl(query.sessionId)} download><FileArchive size={16} /><div><strong>Portable session bundle (.zip)</strong><small>All retained entries and run parameters</small></div></a></Menu.Item>
            <Menu.Item className="menu-item" asChild disabled={!page?.matchCount || loading || !!error}>
              <a href={buildExportUrl(query, exportId)} download><Download size={16} /><div><strong>Matching records (.jsonl)</strong><small>All entries matching your current filters</small></div></a>
            </Menu.Item>
          </Menu.Content></Menu.Portal>
        </Menu.Root>
        </div>
      </div>
      <div className="filter-row">
        <span className="field-label"><Filter size={13} /> Filters</span>
        <LevelFilter value={query.levels} onChange={levels => onChange({ ...query, levels, severity: "all" })} />
        <SelectControl id="stream" label="Stream" value={query.stream} choices={[
          { value: "all", label: "All streams" }, ...Streams.map(value => ({ value, label: value }))
        ]} onChange={stream => onChange({ ...query, stream })} />
        <SelectControl id="category" label="Category" value={query.category} choices={categories}
          onChange={category => onChange({ ...query, category })} />
        <SelectControl id="timeWindow" label="Time window" value={String(query.timeWindow)} choices={TimeChoices}
          onChange={value => onChange({ ...query, timeWindow: Number(value) })} />
        <span className="filter-separator" />
        <label className="checkbox-label"><input id="caseSensitive" type="checkbox" checked={query.matchCase}
          onChange={event => onChange({ ...query, matchCase: event.target.checked })} />Match case</label>
        <button id="reset" className="ghost-button" onClick={onReset}><RotateCcw size={13} /> Reset</button>
      </div>
      {query.conditions.length > 0 && (
        <div id="filterChips" className="filter-chips" aria-label="Active condition filters">
          <span className="chip-logic">Includes: {query.includeMode === "all" ? "AND" : "OR"} · Excludes: OR</span>
          {query.conditions.map((condition, index) => (
            <span className={`filter-chip ${condition.mode}`} key={`${index}-${condition.field}`}>
              <span title={condition.value}>{condition.mode === "include" ? "+" : "−"} {FieldLabels[condition.field]} {OperatorLabels[condition.operator]} <strong>{condition.value}</strong></span>
              <button className="icon-button" aria-label={`Remove ${condition.mode} condition on ${condition.field}`}
                onClick={() => onChange({ ...query, conditions: query.conditions.filter((_, current) => current !== index) })}><X size={12} /></button>
            </span>
          ))}
          <button className="ghost-button small" onClick={() => onEdit()}>Edit rules</button>
        </div>
      )}
      {error && <div id="searchError" className="notice danger" role="alert"><span>{error}</span><button onClick={() => onEdit()}>Edit conditions</button></div>}
    </section>
  );
}
