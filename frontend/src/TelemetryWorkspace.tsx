import { useEffect, useState } from "react";
import { errorMessage } from "./model";
import { fetchTelemetry, type TelemetrySnapshot, type TelemetrySpan, type TelemetryTag } from "./telemetry-api";
import { chartPoints, displayText, MaximumDisplayedPoints, MaximumDisplayedSeries, MaximumDisplayedTraces, metricSeries, spanRelation, traceGroups } from "./telemetry-model";

export type TelemetryView = "metrics" | "traces";
function Tags({ tags }: { tags: TelemetryTag[] }) {
  return <><dl className="telemetry-tags">{tags.slice(0, 32).map((tag, index) =>
    <div key={index}><dt>{displayText(tag.key)}</dt><dd>{displayText(tag.value)}</dd></div>)}</dl>
    {tags.length > 32 && <p className="muted">Showing 32 of {tags.length} tags.</p>}</>;
}
function SpanDetails({ span, spans }: { span: TelemetrySpan; spans: TelemetrySpan[] }) {
  return <section className="telemetry-card" aria-label="Selected span details">
    <h3>{displayText(span.name)}</h3>
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
    <h4>Tags</h4>{span.tags.length ? <Tags tags={span.tags} /> : <p>No tags.</p>}
    <h4>Links</h4>{span.links.length ? <ul>{span.links.slice(0, 32).map((link, index) =>
      <li key={index}>Trace {displayText(link.traceId)} · Span {displayText(link.spanId)}</li>)}</ul> : <p>No links.</p>}
    {span.links.length > 32 && <p>Showing 32 of {span.links.length} links.</p>}
  </section>;
}
export function TelemetryWorkspace({ view, archived }: { view: TelemetryView; archived: boolean }) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  useEffect(() => {
    setSnapshot(null); setError(null); setSelectedId(null);
    if (archived) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await fetchTelemetry(controller.signal);
        if (!controller.signal.aborted) { setSnapshot(next); setError(null); }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [view, archived]);

  const groups = snapshot ? metricSeries(snapshot.metrics) : [];
  const traces = snapshot ? traceGroups(snapshot.spans) : [];
  const selected = snapshot?.spans.find(span => span.id === selectedId);
  return <div className="telemetry-workspace">
    <div className="workspace-heading"><div><span className="workspace-kicker">NATIVE TELEMETRY</span>
      <h2>{view === "metrics" ? "Metrics" : "Traces"}</h2>
      <p>Recent in-process capture · bounded memory · current run only</p></div></div>
    {archived ? <p role="status">Telemetry is not saved with sessions. Select the current run to view metrics and traces.</p> : <>
      <p className="muted">Capture is opt-in: LOG_STUDIO_TELEMETRY=true with the startup hook, or CaptureTelemetry=true in the library.
        The wrapper alone cannot capture a child process's metrics or traces. Telemetry is separate from log history.</p>
      {error && <p className="notice danger" role="alert">{error} Retrying automatically.</p>}
      {!snapshot && !error && <p role="status">Loading telemetry…</p>}
      {snapshot && !snapshot.enabled && <p role="status">Telemetry capture is disabled. Enable capture and restart the instrumented application.</p>}
      {snapshot?.enabled && <>
        <p className="muted">Snapshot: {snapshot.metrics.length} measurements · {snapshot.spans.length} spans (up to 500 each).
          Dropped/expired: {snapshot.droppedMetrics} measurements · {snapshot.droppedSpans} spans.
          {(snapshot.omittedMetrics !== undefined || snapshot.omittedSpans !== undefined) &&
            ` Older retained records not shown: ${snapshot.omittedMetrics ?? 0} measurements · ${snapshot.omittedSpans ?? 0} spans.`}
          {snapshot.suppressedInstruments !== undefined &&
            ` Instruments refused at capture limit: ${snapshot.suppressedInstruments} (their future measurements are not counted as dropped).`}
          Refreshes every 2 seconds; log Pause does not pause telemetry.</p>
        {view === "metrics" ? <>
          <p>Raw measurements, not cumulative totals or calculated rates. Each tag set is a separate series.
            Showing {Math.min(groups.length, MaximumDisplayedSeries)} of {groups.length} series, up to {MaximumDisplayedPoints} recent points each.</p>
          {!groups.length && <p role="status">No metric measurements captured yet.</p>}
          <div className="telemetry-metrics">{groups.slice(0, MaximumDisplayedSeries).map(([key, metrics]) => {
            const metric = metrics.at(-1)!;
            const points = chartPoints(metrics);
            return <section className="telemetry-card" key={key}>
              <h3>{displayText(metric.name)}</h3>
              <p>{displayText(metric.meter)} · {displayText(metric.instrumentType)} · Unit: {metric.unit === null ? "none" : displayText(metric.unit)}</p>
              <Tags tags={metric.tags} />
              <svg className="telemetry-chart" viewBox="0 0 600 150" role="img" aria-label={`${displayText(metric.name)} raw measurements; values in table below`}>
                <line x1="20" y1="130" x2="580" y2="130" className="telemetry-axis" />
                <polyline points={points.map(point => `${point.x},${point.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" />
                {points.map(point => <circle key={point.metric.id} cx={point.x} cy={point.y} r="3" fill="currentColor"><title>{point.metric.timestamp}: {point.metric.value}</title></circle>)}
              </svg>
              <p>Latest raw measurement: {metric.value} {displayText(metric.unit ?? "")}</p>
              <details><summary>Raw measurement table ({points.length} points)</summary>
                <table><caption>{displayText(metric.name)} raw measurements</caption><thead><tr><th scope="col">Timestamp</th><th scope="col">Value</th></tr></thead>
                  <tbody>{points.map(({ metric }) => <tr key={metric.id}><td>{metric.timestamp}</td><td>{metric.value}</td></tr>)}</tbody></table>
              </details>
            </section>;
          })}</div>
        </> : <>
          <p>Showing {Math.min(traces.length, MaximumDisplayedTraces)} of {traces.length} recent traces. Parents may be outside the retained window.</p>
          {!traces.length && <p role="status">No completed spans captured yet.</p>}
          {selectedId !== null && !selected && <p role="status">The selected span has left the retained window.</p>}
          {selected && <SpanDetails span={selected} spans={snapshot.spans} />}
          {traces.slice(0, MaximumDisplayedTraces).map(([traceId, spans]) => <section className="telemetry-card" key={traceId}>
            <h3>Trace {displayText(traceId)}</h3>
            <ul className="telemetry-spans">{spans.map(span => <li key={span.id}>
              <button className="ghost-button" aria-pressed={selectedId === span.id} onClick={() => setSelectedId(span.id)}>
                {displayText(span.name)} · {span.durationMilliseconds} ms · {displayText(span.status)}
              </button><span className="muted">{spanRelation(span, spans)}</span>
            </li>)}</ul>
          </section>)}
        </>}
      </>}
    </>}
  </div>;
}
