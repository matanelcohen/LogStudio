import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TelemetrySpan } from "./telemetry-api";
import { displayText, MaximumDisplayedTraces, spanRelation, traceGroups, traceMatches, traceWaterfall } from "./telemetry-model";
import { TelemetryTags } from "./TelemetryTags";

const durationFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
function duration(value: number): string {
  return `${value >= 1e6 ? value.toExponential(2) : durationFormat.format(value)} ms`;
}
function SpanDetails({ span, spans }: { span: TelemetrySpan; spans: TelemetrySpan[] }) {
  return <section className="trace-inspector" aria-label="Selected span details">
    <div className="telemetry-panel-heading"><span className="workspace-kicker">SPAN DETAILS</span>
      <span className={`telemetry-status${span.status === "Error" ? " error" : ""}`}>{displayText(span.status)}</span></div>
    <h3>{displayText(span.name)}</h3>
    <p className="trace-inspector-duration">{duration(span.durationMilliseconds)}</p>
    <dl className="telemetry-tags">
      <div><dt>Source</dt><dd>{displayText(span.source)}</dd></div>
      <div><dt>Trace ID</dt><dd>{displayText(span.traceId)}</dd></div>
      <div><dt>Span ID</dt><dd>{displayText(span.spanId)}</dd></div>
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
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const traces = useMemo(() => traceGroups(spans), [spans]);
  const matches = useMemo(() => traces.filter(([traceId, entries]) => traceMatches(traceId, entries, query)), [traces, query]);
  const displayed = matches.slice(0, MaximumDisplayedTraces);
  const pinned = matches.find(([traceId]) => traceId === selectedTraceId);
  if (pinned && !displayed.includes(pinned)) displayed[displayed.length - 1] = pinned;
  const active = displayed.find(([traceId]) => traceId === selectedTraceId) ?? displayed[0];
  const activeSpans = active?.[1] ?? [];
  const waterfall = traceWaterfall(activeSpans);
  const selected = activeSpans.find(span => span.id === selectedId) ?? (selectedId === null ? waterfall.rows[0]?.span : undefined);
  function selectSpan(id: number) {
    setSelectedTraceId(active![0]);
    setSelectedId(id);
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
          value={query} onChange={event => { setQuery(event.target.value); setSelectedId(null); setCollapsed(new Set()); }} /></label>
      <span className="muted">Showing {displayed.length} of {matches.length} {query.trim() ? "matching " : "recent "}traces.</span>
    </div>
    {!traces.length ? <p className="telemetry-empty" role="status">No completed spans captured yet.</p> :
      !matches.length ? <p className="telemetry-empty" role="status">No traces match this search.</p> :
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
                <span className="muted">{displayText(root.source)}</span>
                <code>{displayText(traceId)}</code>
                <span className="trace-list-footer"><span>{entries.length} spans</span>
                  <span className={`telemetry-status${errors ? " error" : ""}`}>{errors ? `${errors} errors` : "No errors"}</span></span>
              </button></li>;
            })}</ul>
          </section>
          <section className="trace-waterfall" aria-label="Span waterfall">
            <div className="telemetry-panel-heading"><div><h3>{displayText(waterfall.rows[0]!.span.name)}</h3>
              <code className="muted">{displayText(active![0])}</code></div><strong>{duration(waterfall.duration)}</strong></div>
            <p className="muted trace-window-note">Retained spans only · Parents may be outside the retained window.</p>
            {selectedId !== null && !spans.some(span => span.id === selectedId) &&
              <p role="status" className="notice">The selected span has left the retained window.</p>}
            <div className="trace-waterfall-scroll">
              <div className="waterfall-scale"><span>Operation / source</span><div><span>0 ms</span>
                <span>{duration(waterfall.duration / 2)}</span><span>{duration(waterfall.duration)}</span></div><span>Duration</span></div>
              <ul className="waterfall-rows">{visibleRows.map(row => <li key={row.span.id}
                className={`waterfall-row${selected?.id === row.span.id ? " selected" : ""}${row.span.status === "Error" ? " error" : ""}`}>
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
