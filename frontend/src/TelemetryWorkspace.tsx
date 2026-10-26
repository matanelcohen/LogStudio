import * as Oui from "@opensearch-project/oui";
import { Activity, Clock3, Database, GitBranch, Search, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { MetricChart } from "./MetricChart";
import { errorMessage } from "./model";
import { fetchTelemetry, type TelemetrySnapshot } from "./telemetry-api";
import { displayText, MaximumDisplayedPoints, MaximumDisplayedSeries, metricSeries, recentMeasurements, telemetrySourceColor, traceGroups } from "./telemetry-model";
import { TelemetrySourcesDialog } from "./TelemetrySourcesDialog";
import { TelemetryTags } from "./TelemetryTags";
import { TraceExplorer } from "./TraceExplorer";
import { SelectControl } from "./ui";

export type TelemetryView = "metrics" | "traces";
export function TelemetryWorkspace({ view, archived }: { view: TelemetryView; archived: boolean }) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [meter, setMeter] = useState("");
  useEffect(() => {
    setSnapshot(null); setError(null);
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

  const groups = useMemo(() => snapshot ? metricSeries(snapshot.metrics) : [], [snapshot]);
  const meters = useMemo(() => [...new Set(groups.map(([, metrics]) => metrics[0]!.meter))].sort(), [groups]);
  const matchingGroups = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return groups.filter(([, metrics]) => {
      const metric = metrics.at(-1)!;
      return (!meter || metric.meter === meter) && (!term ||
        [metric.name, metric.meter, metric.instrumentType, metric.unit ?? "", ...metric.tags.flatMap(tag => [tag.key, tag.value])]
          .some(value => value.toLocaleLowerCase().includes(term)));
    });
  }, [groups, query, meter]);
  const traceCount = useMemo(() => traceGroups(snapshot?.spans ?? []).length, [snapshot]);
  const spanSources = useMemo(() => new Set(snapshot?.spans.map(span => span.source)).size, [snapshot]);
  const errorSpans = snapshot?.spans.filter(span => span.status === "Error").length ?? 0;
  const refreshLabel = error ? "Reconnecting" : !snapshot ? "Connecting" : !snapshot.enabled ? "Capture disabled" : "Auto-refresh · 2s";
  return <div className="telemetry-workspace">
    <div className="workspace-heading"><div><span className="workspace-kicker">OBSERVABILITY / CURRENT RUN</span>
      <h2>{view === "metrics" ? "Metrics" : "Traces"}</h2>
      <p>{view === "metrics" ? "Explore instruments, compare tag sets, and inspect raw measurements." : "Find slow requests and errors, then follow the span timeline."}</p></div>
      {!archived && <div className="telemetry-heading-actions">
        <span className={`telemetry-live${error ? " reconnecting" : !snapshot?.enabled ? " inactive" : ""}`}>{refreshLabel}</span>
        <span className="telemetry-window"><Clock3 size={14} aria-hidden="true" />Retained window</span>
        <TelemetrySourcesDialog key={view} /></div>}</div>
    {archived ? <div className="telemetry-empty" role="status"><Database size={28} aria-hidden="true" />
      <h3>Current-run telemetry only</h3><p>Telemetry is not saved with sessions. Select the current run to view metrics and traces.</p></div> : <>
      {error && <Oui.Alert variant="destructive" className="notice danger" role="alert">{error} Retrying automatically.</Oui.Alert>}
      {!snapshot && !error && <p className="telemetry-empty" role="status">Loading telemetry…</p>}
      {snapshot && !snapshot.enabled && <div className="telemetry-empty" role="status"><Activity size={28} aria-hidden="true" />
        <h3>Enable telemetry to get started</h3><p>Telemetry capture is disabled. Enable capture and restart the instrumented application.</p></div>}
      {snapshot?.enabled && <>
        <div className="telemetry-overview" aria-label={view === "metrics" ? "Metric snapshot summary" : "Trace snapshot summary"}>
          <div><span className="telemetry-stat-label">{view === "metrics" ? "Metric series" : "Recent traces"}{view === "metrics" ? <Activity size={16} aria-hidden="true" /> : <GitBranch size={16} aria-hidden="true" />}</span>
            <strong>{view === "metrics" ? groups.length : traceCount}</strong><small>{view === "metrics" ? "Distinct instrument + tag sets" : "Grouped by trace ID"}</small></div>
          <div><span className="telemetry-stat-label">{view === "metrics" ? "Measurements" : "Completed spans"}<Database size={16} aria-hidden="true" /></span>
            <strong>{view === "metrics" ? snapshot.metrics.length : snapshot.spans.length}</strong><small>In the retained snapshot</small></div>
          <div><span className="telemetry-stat-label">{view === "metrics" ? "Meter sources" : "Error spans"}{view === "metrics" ? <Activity size={16} aria-hidden="true" /> : <ShieldAlert size={16} aria-hidden="true" />}</span>
            <strong className={view === "traces" && errorSpans ? "telemetry-error-value" : undefined}>{view === "metrics" ? meters.length : errorSpans}</strong>
            <small>{view === "metrics" ? "Reporting measurements" : "Spans with Error status"}</small></div>
          <div><span className="telemetry-stat-label">{view === "metrics" ? "Point limit / series" : "Activity sources"}<Clock3 size={16} aria-hidden="true" /></span>
            <strong>{view === "metrics" ? MaximumDisplayedPoints : spanSources}</strong><small>{view === "metrics" ? "Recent raw points, not aggregates" : "Reporting completed spans"}</small></div>
        </div>
        {view === "metrics" ? <>
          <div className="telemetry-toolbar">
            <label className="telemetry-search"><Search size={16} aria-hidden="true" />
              <Oui.Input type="search" aria-label="Search metrics" placeholder="Search instruments, sources, or tags"
                value={query} onChange={event => setQuery(event.target.value)} /></label>
            <label className="telemetry-filter"><span>Source</span><SelectControl label="Metric source" value={meter} onChange={setMeter}
              choices={[{ value: "", label: "All meters" }, ...meters.map(source => ({ value: source, label: displayText(source) })),
                ...(meter && !meters.includes(meter) ? [{ value: meter, label: `${displayText(meter)} (not retained)` }] : [])]} /></label>
            {(query || meter) && <Oui.Button variant="ghost" size="sm" className="ghost-button" onClick={() => { setQuery(""); setMeter(""); }}><X size={14} aria-hidden="true" />Reset filters</Oui.Button>}
          </div>
          <div className="telemetry-results-heading"><h3>Measurement panels <span>{Math.min(matchingGroups.length, MaximumDisplayedSeries)}</span></h3>
            <span className="muted">Showing {Math.min(matchingGroups.length, MaximumDisplayedSeries)} of {matchingGroups.length} {query.trim() || meter ? "matching " : ""}series, up to {MaximumDisplayedPoints} recent points each.</span></div>
          <p className="muted telemetry-series-note">Raw measurements, not cumulative totals or calculated rates. Each tag set is a separate series.</p>
          {!groups.length ? <div className="telemetry-empty" role="status"><Activity size={28} aria-hidden="true" />
            <h3>No metric measurements captured yet.</h3><p>Check your source configuration and let the instrumented application emit measurements.</p></div> :
            !matchingGroups.length && <div className="telemetry-empty" role="status"><Search size={28} aria-hidden="true" />
              <h3>No metrics match these filters.</h3><p>Try a different instrument, source, or tag.</p></div>}
          <div className="telemetry-metrics">{matchingGroups.slice(0, MaximumDisplayedSeries).map(([key, metrics]) => {
            const metric = metrics.at(-1)!;
            const points = recentMeasurements(metrics);
            return <section className="telemetry-card" key={key} style={{ "--telemetry-series-color": telemetrySourceColor(metric.meter) } as CSSProperties}>
              <div className="metric-card-header"><div className="telemetry-panel-heading"><h3><i className="telemetry-color-key" aria-hidden="true" />{displayText(metric.name)}</h3>
                <span className="telemetry-status">{displayText(metric.instrumentType)}</span></div>
                <p className="muted metric-source">{displayText(metric.meter)} · Unit: {metric.unit === null ? "none" : displayText(metric.unit)}</p></div>
              <div className="metric-stat-row"><div className="metric-latest"><span>Latest raw measurement</span><strong>{metric.value}<small>{displayText(metric.unit ?? "")}</small></strong></div>
                <span className="metric-point-count"><strong>{points.length}</strong> raw points</span></div>
              <TelemetryTags tags={metric.tags} compact />
              <MetricChart metrics={metrics} />
              <details><summary>Raw measurement table ({points.length} points)</summary>
                <Oui.Table><Oui.TableCaption>{displayText(metric.name)} raw measurements</Oui.TableCaption><Oui.TableHeader><Oui.TableRow><Oui.TableHead scope="col">Timestamp</Oui.TableHead><Oui.TableHead scope="col">Value</Oui.TableHead></Oui.TableRow></Oui.TableHeader>
                  <Oui.TableBody>{points.map(metric => <Oui.TableRow key={metric.id}><Oui.TableCell>{metric.timestamp}</Oui.TableCell><Oui.TableCell>{metric.value}</Oui.TableCell></Oui.TableRow>)}</Oui.TableBody></Oui.Table>
              </details>
            </section>;
          })}</div>
        </> : <TraceExplorer spans={snapshot.spans} />}
        <details className="telemetry-capture-help"><summary>Capture health and retention</summary>
          <p className="muted">Snapshot: {snapshot.metrics.length} measurements · {snapshot.spans.length} spans (up to 500 each).
          Dropped/expired: {snapshot.droppedMetrics} measurements · {snapshot.droppedSpans} spans.
          {(snapshot.omittedMetrics !== undefined || snapshot.omittedSpans !== undefined) &&
            ` Older retained records not shown: ${snapshot.omittedMetrics ?? 0} measurements · ${snapshot.omittedSpans ?? 0} spans.`}
          {snapshot.suppressedInstruments !== undefined &&
            ` Instruments refused at capture limit: ${snapshot.suppressedInstruments} (their future measurements are not counted as dropped).`}
          Refreshes every 2 seconds; log Pause does not pause telemetry.</p></details>
      </>}
      <details className="telemetry-capture-help"><summary>About native telemetry capture</summary>
        <p className="muted">Capture is opt-in: LOG_STUDIO_TELEMETRY=true with the startup hook, or CaptureTelemetry=true in the library.
          The wrapper alone cannot capture a child process's metrics or traces. Telemetry is separate from log history.</p></details>
    </>}
  </div>;
}
