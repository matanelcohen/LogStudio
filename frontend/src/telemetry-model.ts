import type { MetricMeasurement, TelemetrySpan } from "./telemetry-api";

export const MaximumDisplayedSeries = 12;
export const MaximumDisplayedTraces = 50;
export const MaximumDisplayedPoints = 100;
export function displayText(value: string): string { return value.length > 512 ? `${value.slice(0, 512)}…` : value; }
export function metricSeriesKey(metric: MetricMeasurement): string {
  const tags = metric.tags.map(tag => [tag.key, tag.value]).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([metric.meter, metric.name, metric.unit, metric.instrumentType, tags]);
}
export function metricSeries(metrics: MetricMeasurement[]) {
  const groups = new Map<string, MetricMeasurement[]>();
  for (const metric of metrics) {
    const key = metricSeriesKey(metric);
    const group = groups.get(key) ?? [];
    group.push(metric); groups.set(key, group);
  }
  return [...groups].sort((a, b) => (b[1].at(-1)?.id ?? 0) - (a[1].at(-1)?.id ?? 0));
}
export function chartPoints(metrics: MetricMeasurement[]): { x: number; y: number; metric: MetricMeasurement }[] {
  const points = metrics.slice(-MaximumDisplayedPoints);
  if (!points.length) return [];
  const times = points.map(metric => Date.parse(metric.timestamp));
  const minimumTime = Math.min(...times), maximumTime = Math.max(...times);
  const minimum = Math.min(...points.map(metric => metric.value));
  const maximum = Math.max(...points.map(metric => metric.value));
  // Normalize before subtraction so even opposite extreme finite values stay finite.
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum), 1);
  const range = maximum / scale - minimum / scale;
  return points.map((metric, i) => ({
    metric,
    x: maximumTime === minimumTime ? 300 : 20 + 560 * ((times[i]! - minimumTime) / (maximumTime - minimumTime)),
    y: range === 0 ? 75 : 130 - 110 * ((metric.value / scale - minimum / scale) / range)
  }));
}
export function traceGroups(spans: TelemetrySpan[]) {
  const groups = new Map<string, TelemetrySpan[]>();
  for (const span of spans) {
    const group = groups.get(span.traceId) ?? [];
    group.push(span); groups.set(span.traceId, group);
  }
  return [...groups].sort((a, b) => (b[1].at(-1)?.id ?? 0) - (a[1].at(-1)?.id ?? 0));
}
export function spanRelation(span: TelemetrySpan, spans: TelemetrySpan[]): string {
  if (!span.parentSpanId || /^0+$/.test(span.parentSpanId)) return "Root span";
  const parent = spans.find(candidate => candidate.traceId === span.traceId && candidate.spanId === span.parentSpanId);
  return parent ? `Parent: ${displayText(parent.name)} (${displayText(parent.spanId)})` :
    `Missing parent: ${displayText(span.parentSpanId)} (outside retained capture)`;
}
export function recentMeasurements(metrics: MetricMeasurement[]): MetricMeasurement[] {
  return metrics.slice(-MaximumDisplayedPoints).sort((a, b) =>
    Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id - b.id);
}
export function measurementScale(metrics: MetricMeasurement[]): number {
  const maximum = Math.max(...metrics.map(metric => Math.abs(metric.value)), 0);
  // Keep canvas calculations finite, including opposite extremes and subnormal values.
  return maximum === 0 ? 1 : maximum;
}
export interface WaterfallRow {
  span: TelemetrySpan;
  depth: number;
  hasChildren: boolean;
  startPercent: number;
  widthPercent: number;
}
export function traceWaterfall(spans: TelemetrySpan[]): { rows: WaterfallRow[]; duration: number } {
  if (!spans.length) return { rows: [], duration: 0 };
  const start = Math.min(...spans.map(span => Date.parse(span.startTime)));
  const offsets = new Map(spans.map(span => [span.id, Date.parse(span.startTime) - start]));
  // Divide before adding so even very large finite durations cannot overflow.
  const scale = Math.max(...spans.map(span => span.durationMilliseconds), ...offsets.values(), 1);
  const end = Math.max(...spans.map(span => offsets.get(span.id)! / scale + span.durationMilliseconds / scale));
  const ordered = [...spans].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id - b.id);
  const children = new Map<string, TelemetrySpan[]>();
  for (const span of ordered) {
    const key = JSON.stringify([span.traceId, span.parentSpanId]);
    const group = children.get(key) ?? [];
    group.push(span); children.set(key, group);
  }
  const visited = new Set<number>();
  const rows: WaterfallRow[] = [];
  function visit(span: TelemetrySpan, depth: number) {
    if (visited.has(span.id)) return;
    visited.add(span.id);
    const descendants = children.get(JSON.stringify([span.traceId, span.spanId])) ?? [];
    rows.push({
      span, depth, hasChildren: descendants.some(child => child.id !== span.id),
      startPercent: end === 0 ? 0 : 100 * (offsets.get(span.id)! / scale) / end,
      widthPercent: end === 0 ? 0 : 100 * (span.durationMilliseconds / scale) / end
    });
    for (const child of descendants) visit(child, depth + 1);
  }
  for (const span of ordered) {
    if (!span.parentSpanId || /^0+$/.test(span.parentSpanId) ||
      !spans.some(parent => parent.traceId === span.traceId && parent.spanId === span.parentSpanId)) visit(span, 0);
  }
  // Orphaned cycles still appear once, without recursive loops.
  for (const span of ordered) visit(span, 0);
  return { rows, duration: Math.min(end * scale, Number.MAX_VALUE) };
}
export function traceMatches(traceId: string, spans: TelemetrySpan[], query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  return !term || traceId.toLocaleLowerCase().includes(term) || spans.some(span =>
    [span.name, span.source, span.status, ...span.tags.flatMap(tag => [tag.key, tag.value])]
      .some(value => value.toLocaleLowerCase().includes(term)));
}
