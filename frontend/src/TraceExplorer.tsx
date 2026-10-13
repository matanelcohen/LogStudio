import { ChevronDown, ChevronRight, GitBranch, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { TelemetrySpan } from "./telemetry-api";
import { displayText, MaximumDisplayedTraces, spanRelation, telemetrySourceColor, traceGroups, traceMatches, traceWaterfall } from "./telemetry-model";
import { TelemetryTags } from "./TelemetryTags";

const durationFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
const startFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function duration(value: number): string {
  return `${value >= 1e6 ? value.toExponential(2) : durationFormat.format(value)} ms`;
}
function SpanDetails({ span, spans }: { span: TelemetrySpan; spans: TelemetrySpan[] }) {
  return <section className="trace-inspector" aria-label="Selected span details">
    <div className="telemetry-panel-heading"><span className="workspace-kicker">SPAN DETAILS</span>
      <span className={`telemetry-status${span.status === "Error" ? " error" : ""}`}>{displayText(span.status)}</span></div>
    <h3>{displayText(span.name)}</h3>
    <div className="trace-inspector-stat"><p className="trace-inspector-duration">{duration(span.durationMilliseconds)}</p>
      <span className="telemetry-status">{displayText(span.kind)}</span></div>
    <dl className="telemetry-tags trace-metadata">
      <div><dt>Source</dt><dd>{displayText(span.source)}</dd></div>
      <div><dt>Trace ID</dt><dd><code>{displayText(span.traceId)}</code></dd></div>
      <div><dt>Span ID</dt><dd><code>{displayText(span.spanId)}</code></dd></div>
      <div><dt>Relationship</dt><dd>{spanRelation(span, spans)}</dd></div>
      <div><dt>Start</dt><dd>{span.startTime}</dd></div>
      <div><dt>Duration</dt><dd>{span.durationMilliseconds} ms</dd></div>
      <div><dt>Kind</dt><dd>{displayText(span.kind)}</dd></div>
      <div><dt>Status</dt><dd>{displayText(span.status)}{span.statusDescription && `: ${displayText(span.statusDescription)}`}</dd></div>
    </dl>
    <h4>Tags</h4>{span.tags.length ? <TelemetryTags tags={span.tags} /> : <p className="muted">No tags.</p>}
    <h4>Links</h4>{span.links.length ? <ul>{span.links.slice(0, 32).map((link, index) =>
      <li key={index}>Trace {displayText(link.traceId)} · Span {displayText(link.spanId)}</li>)}</ul> : <p className="muted">No links.</p>}
    {span.links.length > 32 && <p>Showing 32 of {span.links.length} links.</p>}
  </section>;
}

export function TraceExplorer({ spans }: { spans: TelemetrySpan[] }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState("recent");
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const traces = useMemo(() => traceGroups(spans), [spans]);
  const matches = useMemo(() => {
    const filtered = traces.filter(([traceId, entries]) => traceMatches(traceId, entries, query) &&
      (!statusFilter || entries.some(span => span.status === "Error") === (statusFilter === "errors")));
    return sort === "duration" ? filtered.sort((a, b) => traceWaterfall(b[1]).duration - traceWaterfall(a[1]).duration) : filtered;
  }, [traces, query, statusFilter, sort]);
  const displayed = matches.slice(0, MaximumDisplayedTraces);
  const pinned = matches.find(([traceId]) => traceId === selectedTraceId);
  if (pinned && !displayed.includes(pinned)) displayed[displayed.length - 1] = pinned;
  const active = displayed.find(([traceId]) => traceId === selectedTraceId) ?? displayed[0];
  const activeSpans = active?.[1] ?? [];
  const waterfall = traceWaterfall(activeSpans);
  const sources = [...new Set(activeSpans.map(span => span.source))].sort();
  const errors = activeSpans.filter(span => span.status === "Error").length;
  const selected = activeSpans.find(span => span.id === selectedId) ?? (selectedId === null ? waterfall.rows[0]?.span : undefined);
  function selectSpan(id: number) {
    setSelectedTraceId(active![0]);
    setSelectedId(id);
  }
  function resetSelection() {
    setSelectedTraceId(null); setSelectedId(null); setCollapsed(new Set());
  }
  let hiddenDepth: number | null = null;
  const visibleRows = waterfall.rows.filter(row => {
    if (hiddenDepth !== null && row.depth > hiddenDepth) return false;
    hiddenDepth = collapsed.has(row.span.id) ? row.depth : null;
    return true;
  });
  useEffect(() => {
    setCollapsed(previous => new Set([...previous].filter(id => spans.some(span => span.id === id))));
  }, [spans]);

  return <>
    <div className="telemetry-toolbar">
      <label className="telemetry-search"><Search size={16} aria-hidden="true" />
        <input type="search" aria-label="Search traces" placeholder="Search trace ID, operation, source, status, or tags"
          value={query} onChange={event => { setQuery(event.target.value); resetSelection(); }} /></label>
      <label className="telemetry-filter"><span>Status</span><select aria-label="Trace status" value={statusFilter}
        onChange={event => { setStatusFilter(event.target.value); resetSelection(); }}>
        <option value="">All traces</option><option value="errors">With errors</option><option value="no-errors">No retained errors</option>
      </select></label>
      <label className="telemetry-filter"><span>Sort</span><select aria-label="Sort traces" value={sort} onChange={event => setSort(event.target.value)}>
        <option value="recent">Newest first</option><option value="duration">Longest first</option>
      </select></label>
      {(query || statusFilter || sort !== "recent") && <button className="ghost-button" onClick={() => {
        setQuery(""); setStatusFilter(""); setSort("recent"); resetSelection();
      }}><X size={14} aria-hidden="true" />Reset filters</button>}
    </div>
    <div className="telemetry-results-heading"><h3>Trace explorer <span>{displayed.length}</span></h3>
      <span className="muted">Showing {displayed.length} of {matches.length} {query.trim() || statusFilter ? "matching " : "recent "}traces.</span></div>
    {!traces.length ? <div className="telemetry-empty" role="status"><GitBranch size={28} aria-hidden="true" />
      <h3>No completed spans captured yet.</h3><p>Check your activity sources and let the instrumented application complete a request.</p></div> :
      !matches.length ? <div className="telemetry-empty" role="status"><Search size={28} aria-hidden="true" />
        <h3>No traces match this search.</h3><p>Try a different query or reset the status filter.</p></div> :
        <div className="trace-explorer">
          <section className="trace-list" aria-label="Trace list">
            <div className="telemetry-panel-heading"><h3>Recent traces</h3><span className="muted">{displayed.length}</span></div>
            <ul>{displayed.map(([traceId, entries]) => {
              const summary = traceWaterfall(entries);
              const root = summary.rows[0]!.span;
              const errors = entries.filter(span => span.status === "Error").length;
              return <li key={traceId}><button className="trace-list-item" aria-pressed={active?.[0] === traceId}
                onClick={() => { setSelectedTraceId(traceId); setSelectedId(null); setCollapsed(new Set()); }}>
                <span className="trace-list-title"><strong>{displayText(root.name)}</strong><span>{duration(summary.duration)}</span></span>
                <span className="trace-list-source"><i className="telemetry-color-key" aria-hidden="true" style={{ background: telemetrySourceColor(root.source) }} />{displayText(root.source)}</span>
                <code>{displayText(traceId)}</code>
                <span className="trace-list-footer"><span>{entries.length} spans · <time dateTime={root.startTime} title={root.startTime}>{startFormat.format(new Date(root.startTime))}</time></span>
                  <span className={`telemetry-status${errors ? " error" : ""}`}>{errors ? `${errors} errors` : "No retained errors"}</span></span>
              </button></li>;
            })}</ul>
          </section>
          <section className="trace-waterfall" aria-label="Span waterfall">
            <div className="telemetry-panel-heading"><div><span className="workspace-kicker">TRACE TIMELINE</span><h3>{displayText(waterfall.rows[0]!.span.name)}</h3>
              <code className="muted">{displayText(active![0])}</code></div><div className="trace-summary-duration"><strong>{duration(waterfall.duration)}</strong>
                <span>{activeSpans.length} spans · {sources.length} sources</span></div></div>
            <div className="trace-source-legend" aria-label="Span sources">{sources.map(source => <span key={source}>
              <i className="telemetry-color-key" aria-hidden="true" style={{ background: telemetrySourceColor(source) }} />{displayText(source)}</span>)}
              {errors > 0 && <span className="trace-error-key">{errors} error spans</span>}</div>
            <p className="muted trace-window-note">Retained spans only · Parents may be outside the retained window.</p>
            {selectedId !== null && !spans.some(span => span.id === selectedId) &&
              <p role="status" className="notice">The selected span has left the retained window.</p>}
            <div className="trace-waterfall-scroll">
              <div className="waterfall-scale"><span>Operation / source</span><div><span>0 ms</span>
                <span>{duration(waterfall.duration / 2)}</span><span>{duration(waterfall.duration)}</span></div><span>Duration</span></div>
              <ul className="waterfall-rows">{visibleRows.map(row => <li key={row.span.id}
                className={`waterfall-row${selected?.id === row.span.id ? " selected" : ""}${row.span.status === "Error" ? " error" : ""}`}
                style={{ "--telemetry-series-color": telemetrySourceColor(row.span.source) } as CSSProperties}>
                <div className="waterfall-operation" style={{ paddingLeft: `${Math.min(row.depth, 12) * 12 + 8}px` }}>
                  {row.hasChildren ? <button className="icon-button waterfall-toggle" aria-label={`${collapsed.has(row.span.id) ? "Expand" : "Collapse"} ${displayText(row.span.name)}`}
                    aria-expanded={!collapsed.has(row.span.id)} onClick={() => setCollapsed(previous => {
                      const next = new Set(previous);
                      if (next.has(row.span.id)) next.delete(row.span.id); else next.add(row.span.id);
                      return next;
                    })}>{collapsed.has(row.span.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button> : <span className="waterfall-leaf" />}
                  <button className="waterfall-select" aria-pressed={selected?.id === row.span.id}
                    aria-label={`${displayText(row.span.name)} · ${row.span.durationMilliseconds} ms · ${displayText(row.span.status)}`}
                    onClick={() => selectSpan(row.span.id)}>
                    <strong>{displayText(row.span.name)}</strong><span>{displayText(row.span.source)} · {displayText(row.span.status)}</span>
                    <small>{spanRelation(row.span, activeSpans)}</small>
                  </button>
                </div>
                <button className="waterfall-track" aria-label={`Inspect span ${displayText(row.span.spanId)}`}
                  title={`${row.span.startTime} · ${row.span.durationMilliseconds} ms`} onClick={() => selectSpan(row.span.id)}>
                  <span className="waterfall-bar" style={{ left: `${row.startPercent}%`, width: `${row.widthPercent}%` }} />
                </button><span className="waterfall-duration">{duration(row.span.durationMilliseconds)}</span>
              </li>)}</ul>
            </div>
          </section>
          {selected ? <SpanDetails span={selected} spans={activeSpans} /> :
            <aside className="trace-inspector telemetry-empty">Select a span to inspect its details.</aside>}
        </div>}
  </>;
}
