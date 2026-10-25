import * as Oui from "@opensearch-project/oui";

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
    <Oui.Card className="query-bar" role="region" aria-label="Search and filter logs">
      <div className="search-row">
        <div className="search-box">
          <Search size={16} aria-hidden />
          <Oui.Input id="search" aria-label="Search logs" ref={searchRef} type="search" value={query.search}
            maxLength={1024} autoComplete="off" spellCheck={false} aria-invalid={!!error}
            placeholder='Search history: "exact phrases", -exclude, category:Name…'
            onChange={event => onChange({ ...query, search: event.target.value })} />
          <kbd>{shortcut}</kbd>
        </div>
        <Oui.Button variant="outline" size="sm" id="conditionsButton" className="query-builder-button" onClick={() => onEdit()}>
          <SlidersHorizontal size={15} /> Add filter {query.conditions.length > 0 && <span className="button-count">{query.conditions.length}</span>}
        </Oui.Button>
        <Oui.Popover>
          <Oui.PopoverTrigger asChild><Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Search help"><CircleHelp size={17} /></Oui.Button></Oui.PopoverTrigger>

            <Oui.PopoverContent className="popover search-help" sideOffset={8} align="end">
              <h3>Query guide</h3>
              <p>Search terms are literal and AND-ed. Use quoted phrases and <code>-term</code> to exclude.</p>
              <p>Scope terms with <code>category:</code>, <code>level:</code>, <code>stream:</code>, <code>message:</code>, or exact <code>id:</code>.</p>
              <p>The condition builder adds field operators and opt-in regex. Includes support AND / OR; exclusions always win.</p>
              <p className="muted">Only the current page is loaded in memory. Queries and exports read the full disk history.</p>
            </Oui.PopoverContent>

        </Oui.Popover>
        <div className="export-actions">
        <a id="download" className={Oui.buttonVariants({ size: "sm", className: !page?.matchCount || loading || error ? "disabled" : "" })}
          aria-disabled={!page?.matchCount || loading || !!error}
          tabIndex={!page?.matchCount || loading || error ? -1 : undefined}
          href={buildExportUrl(query, exportId)} download={`log-studio-${Date.now()}.jsonl`}
          onClick={event => {
            if (!page?.matchCount || loading || error) event.preventDefault();
            else onNotice(`Streaming export requested for ${NumberFormatter.format(page.matchCount)} matching entries.`);
          }}><Download size={14} /> Export</a>
        <Oui.DropdownMenu>
          <Oui.DropdownMenuTrigger asChild><Oui.Button variant="default" size="sm" className="primary export-menu-button" aria-label="Export options"><ChevronDown size={13} /></Oui.Button></Oui.DropdownMenuTrigger>
          <Oui.DropdownMenuContent className="menu-content export-menu" sideOffset={6} align="end">
            <Oui.DropdownMenuLabel className="menu-label">Export selected session</Oui.DropdownMenuLabel>
            <Oui.DropdownMenuItem className="menu-item" asChild><a href={buildSessionExportUrl(query.sessionId)} download><FileArchive size={16} /><div><strong>Portable session bundle (.zip)</strong><small>All retained entries and run parameters</small></div></a></Oui.DropdownMenuItem>
            <Oui.DropdownMenuItem className="menu-item" asChild disabled={!page?.matchCount || loading || !!error}>
              <a href={buildExportUrl(query, exportId)} download><Download size={16} /><div><strong>Matching records (.jsonl)</strong><small>All entries matching your current filters</small></div></a>
            </Oui.DropdownMenuItem>
          </Oui.DropdownMenuContent>
        </Oui.DropdownMenu>
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
        <label className="checkbox-label"><Oui.Checkbox id="caseSensitive" checked={query.matchCase}
          onCheckedChange={checked => onChange({ ...query, matchCase: checked === true })} />Match case</label>
        <Oui.Button variant="ghost" size="sm" id="reset" className="ghost-button" onClick={onReset}><RotateCcw size={13} /> Reset</Oui.Button>
      </div>
      {query.conditions.length > 0 && (
        <div id="filterChips" className="filter-chips" aria-label="Active condition filters">
          <span className="chip-logic">Includes: {query.includeMode === "all" ? "AND" : "OR"} · Excludes: OR</span>
          {query.conditions.map((condition, index) => (
            <span className={`filter-chip ${condition.mode}`} key={`${index}-${condition.field}`}>
              <span title={condition.value}>{condition.mode === "include" ? "+" : "−"} {FieldLabels[condition.field]} {OperatorLabels[condition.operator]} <strong>{condition.value}</strong></span>
              <Oui.Button variant="ghost" size="icon" className="icon-button" aria-label={`Remove ${condition.mode} condition on ${condition.field}`}
                onClick={() => onChange({ ...query, conditions: query.conditions.filter((_, current) => current !== index) })}><X size={12} /></Oui.Button>
            </span>
          ))}
          <Oui.Button variant="ghost" size="sm" className="ghost-button small" onClick={() => onEdit()}>Edit rules</Oui.Button>
        </div>
      )}
      {error && <Oui.Alert variant="destructive" id="searchError" className="notice danger" role="alert"><span>{error}</span><Oui.Button variant="outline" size="sm" onClick={() => onEdit()}>Edit conditions</Oui.Button></Oui.Alert>}
    </Oui.Card>
  );
}
