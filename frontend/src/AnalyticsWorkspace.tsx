import * as Oui from "@opensearch-project/oui";
import { ArrowUpRight, ChartNoAxesCombined, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AnalyticsChart } from "./AnalyticsChart";
import { AnalyticsCopilot } from "./AnalyticsCopilot";
import { DefaultGraph, formatMeasure, GraphGroups, GraphMeasures, GraphTypes, MaximumSavedGraphs, trendSummary, validateGraph,
  type GraphDefinition, type GraphPoint, type SavedGraph } from "./analytics-model";
import { NumberFormatter, readChoice, sessionFilters, type QueryState } from "./model";
import { useAnalytics } from "./useAnalytics";
import { SelectControl } from "./ui";

const LevelsGraph: GraphDefinition = { name: "Records by log level", groupBy: "level", measure: "count", chartType: "bar" };
const CategoriesGraph: GraphDefinition = { name: "Records by category", groupBy: "category", measure: "count", chartType: "bar" };
export type AnalyticsView = "trends" | "graphs";

export function AnalyticsWorkspace({ view, onView, query, onQuery, maximumId, paused, historyDirectory, clearedThroughId, savedGraphs, onSaveGraphs, saved, graphsReady }: {
  view: AnalyticsView; onView(view: AnalyticsView | "discover"): void;
  query: QueryState; onQuery(query: QueryState): void; maximumId: number | null; paused: boolean;
  historyDirectory: string; clearedThroughId: number;
  savedGraphs: SavedGraph[]; onSaveGraphs(graphs: SavedGraph[]): void; saved: boolean; graphsReady: boolean;
}) {
  const data = useAnalytics(query, maximumId, paused, historyDirectory, clearedThroughId);
  const [graph, setGraph] = useState<GraphDefinition>({ ...DefaultGraph });
  const [editing, setEditing] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRequested, setSaveRequested] = useState(false);
  const snapshot = data.snapshot;
  const scopeKey = JSON.stringify({ filters: sessionFilters(query), dismissedThrough: query.dismissedThrough });
  useEffect(() => setSaveRequested(false), [scopeKey]);
  function openGraph(next: GraphDefinition) {
    setGraph({ ...next }); setEditing(null); setSaveError(null); setSaveRequested(false); onView("graphs");
  }
  function saveGraph() {
    if (!graphsReady) return;
    const next = { ...graph, name: graph.name.trim() };
    const error = validateGraph(next);
    if (error) { setSaveError(error); return; }
    if (savedGraphs.some(saved => saved.graph.name.toLowerCase() === next.name.toLowerCase() && saved.graph.name !== editing)) {
      setSaveError("A graph with this name already exists. Choose a unique name."); return;
    }
    if (!editing && savedGraphs.length >= MaximumSavedGraphs) { setSaveError("Save no more than 10 graphs. Remove a graph first."); return; }
    const savedGraph = { graph: next, filters: sessionFilters(query) };
    onSaveGraphs(editing ? savedGraphs.map(saved => saved.graph.name === editing ? savedGraph : saved) : [...savedGraphs, savedGraph]);
    setGraph(next); setEditing(next.name); setSaveError(null); setSaveRequested(true);
  }
  function explore(definition: GraphDefinition, point: GraphPoint) {
    const next = { ...query };
    if (definition.groupBy === "category") next.category = JSON.stringify(point.group);
    else if (definition.groupBy === "level") next.levels = [readChoice(point.group ?? "", ["output", "trace", "debug", "information", "warning", "error", "critical"])];
    else if (definition.groupBy === "stream") next.stream = point.group ?? "all";
    onQuery(next); onView("discover");
  }
  function chart(definition: GraphDefinition, editable = false) {
    return <section className="analytics-card">
      <div className="analytics-card-heading"><div><h3>{definition.name || "Untitled graph"}</h3><p>{GraphMeasures.find(choice => choice.value === definition.measure)!.label} grouped by {GraphGroups.find(choice => choice.value === definition.groupBy)!.label.toLowerCase()}</p></div>
        {!editable && <Oui.Button variant="ghost" size="sm" aria-label={`Customize ${definition.name}`} onClick={() => openGraph(definition)}>Customize<ArrowUpRight size={14} /></Oui.Button>}</div>
      {snapshot && <AnalyticsChart snapshot={snapshot} graph={definition} onExplore={point => explore(definition, point)} />}
    </section>;
  }
  return <div className="analytics-workspace" aria-label={view === "trends" ? "Session trends" : "Graph builder"}>
    <div className="analytics-scope"><div><span className="analytics-scope-dot" /><strong>Full session analysis</strong>
      <span>All matching, non-deleted disk records · Shared filters above · Not limited to the visible page</span></div>
      <div><span role="status">{data.loading ? "Updating…" : paused ? "Paused snapshot" : "Refreshes every 5s"}</span>
        <Oui.Button variant="ghost" size="sm" disabled={data.loading} onClick={data.refresh} aria-label="Refresh analytics"><RefreshCw size={14} /></Oui.Button>
        {view === "trends" && <Oui.Button variant="default" size="sm" onClick={() => openGraph(DefaultGraph)}><Plus size={14} />Create graph</Oui.Button>}</div>
    </div>
    {data.error && <Oui.Alert variant="destructive" className="notice danger" role="alert">{data.error}{snapshot && " Showing the last successful snapshot."}
      <Oui.Button variant="outline" size="sm" onClick={data.refresh}>Retry analytics</Oui.Button></Oui.Alert>}
    {!snapshot && data.loading && <p className="analytics-empty" role="status">Reading session analytics…</p>}
    {snapshot && <>
      <div className="analytics-stats" aria-label="Filtered session summary">
        {[["Matching records", NumberFormatter.format(snapshot.totalCount), "Across the selected session"],
          ["Error records", NumberFormatter.format(snapshot.errorCount), "Error + critical levels"],
          ["Error percentage", formatMeasure(snapshot.totalCount ? snapshot.errorCount / snapshot.totalCount * 100 : 0, "errorRate"), "Of matching log records"],
          ["Warning records", NumberFormatter.format(snapshot.warningCount), "Warning level only"]].map(([label, value, note]) =>
          <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
      </div>
      {!snapshot.totalCount && <div className="analytics-empty" role="status"><ChartNoAxesCombined size={28} /><h3>No matching logs to analyze</h3><p>Adjust the filters, select another session, import logs, or wait for new output.</p></div>}
    </>}
    <div className="analytics-layout">
      <div className="analytics-main">
        {view === "graphs" ? <>
          <section className="analytics-card analytics-builder" aria-label="Graph configuration">
            <div className="analytics-card-heading"><div><span className="workspace-kicker">GRAPH BUILDER</span><h3>{editing ? "Edit saved graph" : "Build your graph"}</h3></div>
              <Oui.Button variant="ghost" size="sm" onClick={() => openGraph(DefaultGraph)}><Plus size={14} />New graph</Oui.Button></div>
            <div className="analytics-builder-fields">
              <label>Graph name<Oui.Input aria-label="Graph name" value={graph.name} maxLength={64} onChange={event => { setGraph({ ...graph, name: event.target.value }); setSaveRequested(false); }} /></label>
              <label>Measure<SelectControl label="Graph measure" value={graph.measure} choices={GraphMeasures} onChange={value => { setGraph({ ...graph, measure: readChoice(value, GraphMeasures.map(choice => choice.value)) }); setSaveRequested(false); }} /></label>
              <label>Group by<SelectControl label="Graph grouping" value={graph.groupBy} choices={GraphGroups} onChange={value => {
                const groupBy = readChoice(value, GraphGroups.map(choice => choice.value));
                setGraph({ ...graph, groupBy, chartType: groupBy === "time" ? graph.chartType : "bar" }); setSaveRequested(false);
              }} /></label>
              <label>Chart type<SelectControl label="Graph chart type" value={graph.chartType} choices={graph.groupBy === "time" ? GraphTypes : [GraphTypes[1]]}
                onChange={value => { setGraph({ ...graph, chartType: readChoice(value, GraphTypes.map(choice => choice.value)) }); setSaveRequested(false); }} /></label>
            </div>
            <div className="analytics-builder-footer"><p className="muted">Saves this definition and the filters above. Reuse it with any session; data is never copied.</p>
              <Oui.Button variant="default" size="sm" disabled={!graphsReady} onClick={saveGraph}><Save size={14} />{editing ? "Update graph" : "Save graph"}</Oui.Button></div>
            {saveError && <Oui.Alert variant="destructive" className="notice danger" role="alert">{saveError}</Oui.Alert>}
            {saveRequested && <p role="status" className="muted">{saved ? "Graph saved on this device." : "Graph settings pending save. See any settings error above."}</p>}
          </section>
          {chart(graph, true)}
          <section className="analytics-card" aria-label="Saved graphs">
            <div className="analytics-card-heading"><h3>Saved graphs <span className="muted">{savedGraphs.length}/{MaximumSavedGraphs}</span></h3></div>
            {!graphsReady ? <p role="status" className="muted">Waiting for saved graph settings. Resolve any settings error above before saving.</p> :
              !savedGraphs.length && <p className="muted">Save your first graph to reuse its configuration and filters across sessions and restarts.</p>}
            <div className="analytics-saved-graphs">{savedGraphs.map(item => <div key={item.graph.name}>
              <Oui.Button variant="ghost" size="sm" className="analytics-saved-graph" aria-label={`Open graph ${item.graph.name}`} aria-pressed={editing === item.graph.name} onClick={() => {
                setGraph({ ...item.graph }); setEditing(item.graph.name); setSaveError(null); setSaveRequested(false);
                onQuery({ ...query, ...item.filters, dismissedThrough: 0 });
              }}><ChartNoAxesCombined size={16} /><span><strong>{item.graph.name}</strong><small>{GraphMeasures.find(choice => choice.value === item.graph.measure)!.label} · {item.graph.groupBy} · {item.graph.chartType}</small></span></Oui.Button>
              <Oui.Button variant="ghost" size="icon" aria-label={`Delete graph ${item.graph.name}`} onClick={() => {
                onSaveGraphs(savedGraphs.filter(saved => saved.graph.name !== item.graph.name));
                if (editing === item.graph.name) { setEditing(null); setSaveRequested(false); }
              }}><Trash2 size={14} /></Oui.Button>
            </div>)}</div>
          </section>
        </> : <>
          {chart(DefaultGraph)}
          {snapshot && snapshot.totalCount > 0 && <section className="analytics-card analytics-observations" aria-label="Observed trends">
            <span className="workspace-kicker">OBSERVED IN THIS SNAPSHOT</span><h3>What stands out</h3><ul>{trendSummary(snapshot).map(note => <li key={note}>{note}</li>)}</ul>
            <p className="muted">Descriptive comparisons only, not anomaly detection or a claim about root cause.</p>
          </section>}
          <div className="analytics-breakdowns">{chart(LevelsGraph)}{chart(CategoriesGraph)}</div>
        </>}
        <p className="analytics-methodology">Counts represent log records, not requests or latency. Error percentage = (error + critical) / matching records.
          Time uses capture timestamps. Up to 64 first-seen named categories and uncategorized records are shown individually; remaining categories are combined as Other.
          {snapshot?.firstTimestamp && <> Snapshot: {new Date(snapshot.firstTimestamp).toLocaleString()} to {new Date(snapshot.lastTimestamp!).toLocaleString()}, through #{snapshot.status.lastId}.</>}</p>
      </div>
      <AnalyticsCopilot key={scopeKey} parameters={data.parameters} graph={view === "graphs" ? graph : null}
        disabled={!snapshot?.totalCount || data.loading || !!data.error} onGraph={openGraph} />
    </div>
  </div>;
}
