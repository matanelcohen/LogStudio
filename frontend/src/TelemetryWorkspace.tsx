import { Activity, GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MetricChart } from "./MetricChart";
import { errorMessage } from "./model";
import { fetchTelemetry, type TelemetrySnapshot } from "./telemetry-api";
import { displayText, MaximumDisplayedPoints, MaximumDisplayedSeries, metricSeries, recentMeasurements } from "./telemetry-model";
import { TelemetrySourcesDialog } from "./TelemetrySourcesDialog";
import { TelemetryTags } from "./TelemetryTags";
import { TraceExplorer } from "./TraceExplorer";

export type TelemetryView = "metrics" | "traces";
export function TelemetryWorkspace({ view, archived }: { view: TelemetryView; archived: boolean }) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  return <div className="telemetry-workspace">
    <div className="workspace-heading"><div><span className="workspace-kicker">OBSERVABILITY / CURRENT RUN</span>
      <h2>{view === "metrics" ? "Metrics" : "Traces"}</h2>
      <p>{view === "metrics" ? "Explore measurements by instrument and tag set" : "Follow requests from operation to individual span"}</p></div>
      {!archived && <div className="telemetry-heading-actions"><span className="telemetry-live">Auto-refresh · 2s</span><TelemetrySourcesDialog key={view} /></div>}</div>
    {archived ? <p role="status">Telemetry is not saved with sessions. Select the current run to view metrics and traces.</p> : <>
      <details className="telemetry-capture-help"><summary>About native telemetry capture</summary>
        <p className="muted">Capture is opt-in: LOG_STUDIO_TELEMETRY=true with the startup hook, or CaptureTelemetry=true in the library.
          The wrapper alone cannot capture a child process's metrics or traces. Telemetry is separate from log history.</p></details>
      {error && <p className="notice danger" role="alert">{error} Retrying automatically.</p>}
      {!snapshot && !error && <p role="status">Loading telemetry…</p>}
      {snapshot && !snapshot.enabled && <p role="status">Telemetry capture is disabled. Enable capture and restart the instrumented application.</p>}
      {snapshot?.enabled && <>
        <div className="telemetry-overview">
          <div><Activity size={18} aria-hidden="true" /><span>Measurements<strong>{snapshot.metrics.length}</strong></span></div>
          <div><GitBranch size={18} aria-hidden="true" /><span>Completed spans<strong>{snapshot.spans.length}</strong></span></div>
          <div><span>Capture window<strong>Current run</strong></span><small>Up to 500 of each · bounded memory</small></div>
        </div>
        <details className="telemetry-capture-help"><summary>Capture health and retention</summary>
          <p className="muted">Snapshot: {snapshot.metrics.length} measurements · {snapshot.spans.length} spans (up to 500 each).
          Dropped/expired: {snapshot.droppedMetrics} measurements · {snapshot.droppedSpans} spans.
          {(snapshot.omittedMetrics !== undefined || snapshot.omittedSpans !== undefined) &&
            ` Older retained records not shown: ${snapshot.omittedMetrics ?? 0} measurements · ${snapshot.omittedSpans ?? 0} spans.`}
          {snapshot.suppressedInstruments !== undefined &&
            ` Instruments refused at capture limit: ${snapshot.suppressedInstruments} (their future measurements are not counted as dropped).`}
          Refreshes every 2 seconds; log Pause does not pause telemetry.</p></details>
        {view === "metrics" ? <>
          <p className="muted telemetry-series-note">Raw measurements, not cumulative totals or calculated rates. Each tag set is a separate series.
            Showing {Math.min(groups.length, MaximumDisplayedSeries)} of {groups.length} series, up to {MaximumDisplayedPoints} recent points each.</p>
          {!groups.length && <p role="status">No metric measurements captured yet.</p>}
          <div className="telemetry-metrics">{groups.slice(0, MaximumDisplayedSeries).map(([key, metrics]) => {
            const metric = metrics.at(-1)!;
            const points = recentMeasurements(metrics);
            return <section className="telemetry-card" key={key}>
              <div className="telemetry-panel-heading"><h3>{displayText(metric.name)}</h3><span className="telemetry-status">{displayText(metric.instrumentType)}</span></div>
              <p className="muted metric-source">{displayText(metric.meter)} · Unit: {metric.unit === null ? "none" : displayText(metric.unit)}</p>
              <div className="metric-latest"><span>Latest raw measurement</span><strong>{metric.value}<small>{displayText(metric.unit ?? "")}</small></strong></div>
              <TelemetryTags tags={metric.tags} compact />
              <MetricChart metrics={metrics} />
              <details><summary>Raw measurement table ({points.length} points)</summary>
                <table><caption>{displayText(metric.name)} raw measurements</caption><thead><tr><th scope="col">Timestamp</th><th scope="col">Value</th></tr></thead>
                  <tbody>{points.map(metric => <tr key={metric.id}><td>{metric.timestamp}</td><td>{metric.value}</td></tr>)}</tbody></table>
              </details>
            </section>;
          })}</div>
        </> : <TraceExplorer spans={snapshot.spans} />}
      </>}
    </>}
  </div>;
}
