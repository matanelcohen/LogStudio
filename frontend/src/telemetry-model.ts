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
