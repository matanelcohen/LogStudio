import { ApiError, readStatus } from "./api";
import { count, nullableText, object, text, timestamp } from "./apiValues";
import { ClearActionHeader, Severities, Streams, type ChatOptions } from "./model";
import { readGraph, type Aggregate, type AnalyticsInsight, type AnalyticsSnapshot, type GraphDefinition } from "./analytics-model";

function readAggregate(value: unknown): Aggregate {
  const data = object(value);
  const result = { value: nullableText(data.value, "aggregate label"), count: count(data.count, "record count"),
    errorCount: count(data.errorCount, "error count"), warningCount: count(data.warningCount, "warning count") };
  if (result.errorCount + result.warningCount > result.count) throw new Error("The server returned inconsistent analytics counts.");
  return result;
}
export function readAnalytics(value: unknown): AnalyticsSnapshot {
  const data = object(value);
  function groups(value: unknown, limit: number) {
    if (!Array.isArray(value) || value.length > limit) throw new Error("The server returned invalid analytics groups.");
    return value.map(readAggregate);
  }
  if (!Array.isArray(data.timeline) || (data.timeline.length !== 0 && data.timeline.length !== 32))
    throw new Error("The server returned an invalid analytics timeline.");
  const timeline = data.timeline.map(value => {
    const bucket = object(value);
    const { count, errorCount, warningCount } = readAggregate({ ...bucket, value: null });
    return { count, errorCount, warningCount, since: timestamp(bucket.since, "interval start"), until: timestamp(bucket.until, "interval end") };
  });
  const snapshot: AnalyticsSnapshot = {
    totalCount: count(data.totalCount, "matching count"), errorCount: count(data.errorCount, "error count"),
    warningCount: count(data.warningCount, "warning count"),
    firstTimestamp: data.firstTimestamp === null ? null : timestamp(data.firstTimestamp, "first capture time"),
    lastTimestamp: data.lastTimestamp === null ? null : timestamp(data.lastTimestamp, "last capture time"),
    timeline, levels: groups(data.levels, 7), streams: groups(data.streams, 3), categories: groups(data.categories, 65),
    otherCategories: readAggregate(data.otherCategories), status: readStatus(data.status)
  };
  const total = readAggregate({ value: null, count: snapshot.totalCount, errorCount: snapshot.errorCount, warningCount: snapshot.warningCount });
  const equalTotals = (groups: Omit<Aggregate, "value">[]) =>
    groups.reduce((sum, group) => sum + group.count, 0) === total.count &&
    groups.reduce((sum, group) => sum + group.errorCount, 0) === total.errorCount &&
    groups.reduce((sum, group) => sum + group.warningCount, 0) === total.warningCount;
  if (!equalTotals(snapshot.timeline) || !equalTotals(snapshot.levels) || !equalTotals(snapshot.streams) ||
    !equalTotals([...snapshot.categories, snapshot.otherCategories]) ||
    snapshot.levels.some(group => !Severities.some(level => level === group.value)) ||
    snapshot.streams.some(group => !Streams.some(stream => stream === group.value)) ||
    (total.count > 0 ? !snapshot.firstTimestamp || !snapshot.lastTimestamp || snapshot.timeline.length !== 32 ||
      Date.parse(snapshot.firstTimestamp) > Date.parse(snapshot.lastTimestamp) : snapshot.firstTimestamp !== null || snapshot.lastTimestamp !== null || snapshot.timeline.length !== 0) ||
    snapshot.timeline.some((bucket, index) => Date.parse(bucket.since) > Date.parse(bucket.until) ||
      (index > 0 && bucket.since !== snapshot.timeline[index - 1]!.until)))
    throw new Error("The server returned inconsistent session analytics.");
  return snapshot;
}
export async function fetchAnalytics(parameters: URLSearchParams, signal: AbortSignal): Promise<AnalyticsSnapshot> {
  const response = await fetch(`api/analytics?${parameters}`, { signal });
  const value: unknown = await response.json();
  if (!response.ok) throw new ApiError(text(object(value).error, "analytics error"), response.status);
  return readAnalytics(value);
}
export async function askAnalytics(parameters: URLSearchParams, question: string, graph: GraphDefinition | null, options: ChatOptions, signal: AbortSignal): Promise<AnalyticsInsight> {
  const response = await fetch(`api/analytics/copilot?${parameters}`, {
    method: "POST", headers: { [ClearActionHeader]: "copilot-analytics", "Content-Type": "application/json" },
    body: JSON.stringify({ question, graph, ...options }), signal
  });
  const data = object(await response.json());
  if (!response.ok) throw new ApiError(text(data.error, "Copilot analytics error"), response.status);
  const insight = text(data.insight, "Copilot insight");
  if (!insight.trim() || insight.length > 8000) throw new Error("Copilot returned an invalid insight.");
  return { insight, graph: readGraph(data.graph), contextEntryCount: count(data.contextEntryCount, "analyzed records"), throughId: count(data.throughId, "analysis checkpoint") };
}
