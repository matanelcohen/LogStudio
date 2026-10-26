import { NumberFormatter, SeverityLabels, type SessionFilters } from "./model";
import { readSessionFilters } from "./sessionFilters";
import { object, text } from "./apiValues";

export const GraphGroups = [
  { value: "time", label: "Time" }, { value: "level", label: "Log level" },
  { value: "category", label: "Category" }, { value: "stream", label: "Stream" }
] as const;
export const GraphMeasures = [
  { value: "count", label: "Log records" }, { value: "errors", label: "Error records" },
  { value: "warnings", label: "Warning records" }, { value: "errorRate", label: "Error percentage" }
] as const;
export const GraphTypes = [{ value: "line", label: "Line" }, { value: "bar", label: "Bar" }] as const;
export const MaximumSavedGraphs = 10;

export interface GraphDefinition {
  name: string;
  groupBy: typeof GraphGroups[number]["value"];
  measure: typeof GraphMeasures[number]["value"];
  chartType: typeof GraphTypes[number]["value"];
}
export interface SavedGraph { graph: GraphDefinition; filters: SessionFilters; }
export interface Aggregate { value: string | null; count: number; errorCount: number; warningCount: number; }
export interface TimeBucket extends Omit<Aggregate, "value"> { since: string; until: string; }
export interface AnalyticsSnapshot {
  totalCount: number;
  errorCount: number;
  warningCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  timeline: TimeBucket[];
  levels: Aggregate[];
  streams: Aggregate[];
  categories: Aggregate[];
  otherCategories: Aggregate;
  status: import("./model").ViewerStatus;
}
export interface AnalyticsInsight { insight: string; graph: GraphDefinition; contextEntryCount: number; throughId: number; }
export interface GraphPoint { label: string; value: number; group: string | null; since?: string; until?: string; other?: boolean; }
export const DefaultGraph: GraphDefinition = { name: "Log volume over time", groupBy: "time", measure: "count", chartType: "line" };

export function validateGraph(graph: GraphDefinition): string | null {
  if (!graph.name.trim() || graph.name !== graph.name.trim() || graph.name.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(graph.name))
    return "Enter a graph name containing 1-64 characters without control characters.";
  if (!GraphGroups.some(choice => choice.value === graph.groupBy) || !GraphMeasures.some(choice => choice.value === graph.measure) ||
    !GraphTypes.some(choice => choice.value === graph.chartType) || (graph.chartType === "line" && graph.groupBy !== "time"))
    return "Choose a supported measure and grouping. Line charts require time grouping.";
  return null;
}
export function readGraph(value: unknown): GraphDefinition {
  const data = object(value);
  const groupBy = GraphGroups.find(choice => choice.value === data.groupBy)?.value;
  const measure = GraphMeasures.find(choice => choice.value === data.measure)?.value;
  const chartType = GraphTypes.find(choice => choice.value === data.chartType)?.value;
  if (!groupBy || !measure || !chartType) throw new Error("The server returned an unsupported graph.");
  const graph = { name: text(data.name, "graph name"), groupBy, measure, chartType };
  if (validateGraph(graph)) throw new Error("The server returned an invalid graph.");
  return graph;
}
export function readSavedGraphs(value: unknown): SavedGraph[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MaximumSavedGraphs) throw new Error("The server returned invalid saved graphs.");
  const names = new Set<string>();
  return value.map(value => {
    const saved = object(value);
    const graph = readGraph(saved.graph);
    if (names.has(graph.name.toLowerCase())) throw new Error("The server returned duplicate graph names.");
    names.add(graph.name.toLowerCase());
    return { graph, filters: readSessionFilters(saved.filters) };
  });
}
export function measureValue(group: Pick<Aggregate, "count" | "errorCount" | "warningCount">, measure: GraphDefinition["measure"]): number {
  return measure === "errors" ? group.errorCount : measure === "warnings" ? group.warningCount :
    measure === "errorRate" ? group.count ? group.errorCount / group.count * 100 : 0 : group.count;
}
export function formatMeasure(value: number, measure: GraphDefinition["measure"]): string {
  return measure === "errorRate" ? `${value.toFixed(2)}%` : NumberFormatter.format(value);
}
export function graphPoints(snapshot: AnalyticsSnapshot, graph: GraphDefinition): GraphPoint[] {
  if (graph.groupBy === "time") return snapshot.timeline.map(bucket => ({
    label: `${bucket.since} – ${bucket.until}`,
    group: bucket.since, since: bucket.since, until: bucket.until, value: measureValue(bucket, graph.measure)
  }));
  const groups = graph.groupBy === "level" ? snapshot.levels : graph.groupBy === "stream" ? snapshot.streams : snapshot.categories;
  const points: GraphPoint[] = groups.filter(group => group.count > 0).map(group => ({
    label: graph.groupBy === "level" ? SeverityLabels[group.value as keyof typeof SeverityLabels] ?? group.value ?? "Unknown" :
      group.value === null ? "Uncategorized" : group.value === "" ? "(empty category)" : group.value,
    group: group.value, value: measureValue(group, graph.measure)
  }));
  if (graph.groupBy === "category" && snapshot.otherCategories.count)
    points.push({ label: "Other categories (combined)", group: null, value: measureValue(snapshot.otherCategories, graph.measure), other: true });
  return points;
}

export function trendSummary(snapshot: AnalyticsSnapshot): string[] {
  if (!snapshot.totalCount) return [];
  const notes = [`${formatMeasure(snapshot.errorCount / snapshot.totalCount * 100, "errorRate")} of matching records are errors or critical (${NumberFormatter.format(snapshot.errorCount)} of ${NumberFormatter.format(snapshot.totalCount)}).`];
  const peak = snapshot.timeline.reduce<TimeBucket | null>((best, bucket) => !best || bucket.count > best.count ? bucket : best, null);
  if (peak) notes.push(`Busiest interval: ${NumberFormatter.format(peak.count)} records, ${new Date(peak.since).toLocaleString()} to ${new Date(peak.until).toLocaleString()}.`);
  if (snapshot.firstTimestamp !== snapshot.lastTimestamp && snapshot.timeline.length === 32) {
    const first = snapshot.timeline.slice(0, 16).reduce((sum, bucket) => sum + bucket.count, 0);
    const second = snapshot.timeline.slice(16).reduce((sum, bucket) => sum + bucket.count, 0);
    notes.push(`Equal-duration halves: ${NumberFormatter.format(first)} records in the first half; ${NumberFormatter.format(second)} in the second${first ? ` (${((second - first) / first * 100).toFixed(1)}% change)` : "; percentage change is undefined from zero"}.`);
  }
  return notes;
}
