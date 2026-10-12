import { ApiError } from "./api";
import { ApiRoutes } from "./model";

export interface TelemetryTag { key: string; value: string; }
export interface MetricMeasurement {
  id: number; timestamp: string; meter: string; name: string; unit: string | null;
  instrumentType: string; value: number; tags: TelemetryTag[];
}
export interface TelemetrySpan {
  id: number; source: string; name: string; traceId: string; spanId: string; parentSpanId: string;
  startTime: string; durationMilliseconds: number; kind: string; status: string;
  statusDescription: string | null; tags: TelemetryTag[]; links: { traceId: string; spanId: string }[];
}
export interface TelemetrySnapshot {
  enabled: boolean; metrics: MetricMeasurement[]; spans: TelemetrySpan[]; droppedMetrics: number; droppedSpans: number;
  omittedMetrics?: number; omittedSpans?: number; suppressedInstruments?: number;
}
export const MaximumTelemetryRecords = 500;
export const MaximumTelemetryTextLength = 256;
export const MaximumTelemetryTags = 32;
export const MaximumTelemetryLinks = 16;

function invalid(): never { throw new Error("The server returned invalid telemetry."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === "string" && value.length <= MaximumTelemetryTextLength ? value : invalid();
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : invalid();
}
function count(value: unknown): number {
  const result = number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : invalid();
}
function timestamp(value: unknown): string {
  const result = text(value);
  return Number.isFinite(Date.parse(result)) ? result : invalid();
}
function array(value: unknown, maximum: number): unknown[] {
  return Array.isArray(value) && value.length <= maximum ? value : invalid();
}
function tags(value: unknown): TelemetryTag[] {
  return array(value, MaximumTelemetryTags).map(value => { const tag = object(value); return { key: text(tag.key), value: text(tag.value) }; });
}
export function readTelemetry(value: unknown): TelemetrySnapshot {
  const data = object(value);
  if (typeof data.enabled !== "boolean") return invalid();
  return {
    enabled: data.enabled, droppedMetrics: count(data.droppedMetrics), droppedSpans: count(data.droppedSpans),
    ...(data.omittedMetrics === undefined ? {} : { omittedMetrics: count(data.omittedMetrics) }),
    ...(data.omittedSpans === undefined ? {} : { omittedSpans: count(data.omittedSpans) }),
    ...(data.suppressedInstruments === undefined ? {} : { suppressedInstruments: count(data.suppressedInstruments) }),
    metrics: array(data.metrics, MaximumTelemetryRecords).map(value => {
      const metric = object(value);
      return {
        id: count(metric.id), timestamp: timestamp(metric.timestamp), meter: text(metric.meter), name: text(metric.name),
        unit: nullableText(metric.unit), instrumentType: text(metric.instrumentType), value: number(metric.value), tags: tags(metric.tags)
      };
    }),
    spans: array(data.spans, MaximumTelemetryRecords).map(value => {
      const span = object(value);
      const durationMilliseconds = number(span.durationMilliseconds);
      if (durationMilliseconds < 0) return invalid();
      return {
        id: count(span.id), source: text(span.source), name: text(span.name), traceId: text(span.traceId), spanId: text(span.spanId),
        parentSpanId: text(span.parentSpanId), startTime: timestamp(span.startTime), durationMilliseconds,
        kind: text(span.kind), status: text(span.status), statusDescription: nullableText(span.statusDescription), tags: tags(span.tags),
        links: array(span.links, MaximumTelemetryLinks).map(value => { const link = object(value); return { traceId: text(link.traceId), spanId: text(link.spanId) }; })
      };
    })
  };
}
export async function fetchTelemetry(signal: AbortSignal): Promise<TelemetrySnapshot> {
  const response = await fetch(ApiRoutes.Telemetry, { signal });
  if (!response.ok) throw new ApiError(`Could not load telemetry (HTTP ${response.status}).`, response.status);
  return readTelemetry(await response.json());
}
