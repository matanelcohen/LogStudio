import { ApiError, readSessionInfo } from "./api";
import { boolean, count, nullableText, object, text, timestamp } from "./apiValues";
import { ClearActionHeader, Severities, Streams, type LogEntry, type SessionFilters, type SessionInfo } from "./model";
import { readSessionFilters } from "./sessionFilters";

export type ComparisonGrouping = "normalized" | "raw";
export type ComparisonScope = "all" | "saved";
export type ComparisonKind = "severity" | "category" | "message";
export type ComparisonChange = "new" | "resolved" | "changed" | "unchanged";
export type ComparisonState = "running" | "completed" | "cancelled" | "invalidated" | "failed";
export type ComparisonSideName = "baseline" | "candidate";
export interface ComparisonSide {
  session: SessionInfo;
  filters: SessionFilters | null;
  matchedCount: number;
  totalEntries: number;
  durationMilliseconds: number | null;
}
export interface ComparisonSnapshot {
  id: string;
  state: ComparisonState;
  phase: string;
  processedEntries: number;
  totalEntries: number;
  error: string | null;
  baseline: ComparisonSide;
  candidate: ComparisonSide;
  grouping: ComparisonGrouping;
  normalizationRule: string;
}
export interface ComparisonOptions {
  baselineId: string;
  candidateId: string;
  grouping: ComparisonGrouping;
  filterScope: ComparisonScope;
}
export interface ComparisonGroup {
  id: string;
  kind: ComparisonKind;
  label: string;
  severity: string | null;
  category: string | null;
  baselineCount: number;
  candidateCount: number;
  delta: number;
  change: ComparisonChange;
}
export interface ComparisonGroups {
  groups: ComparisonGroup[];
  total: number;
  offset: number;
  pageSize: number;
}
export interface ComparisonEvidence {
  sessionId: string;
  entries: LogEntry[];
  nextAfter: number | null;
}
const PageSize = 50;
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  const result = choices.find(candidate => candidate === value);
  if (result === undefined) throw new Error(`The server returned an invalid comparison ${name}.`);
  return result;
}
function identity(value: unknown, name: string): string {
  const result = text(value, name);
  if (!result) throw new Error(`The server returned an invalid ${name}.`);
  return result;
}
function readSide(value: unknown): ComparisonSide {
  const data = object(value);
  const session = readSessionInfo(data.session);
  if (!session.id || session.isCurrent || !session.completedAt)
    throw new Error("The server returned an ineligible comparison session.");
  const filters = data.filters === null ? null : readSessionFilters(data.filters);
  if (filters && filters.timeWindow !== 0) throw new Error("The server returned unresolved comparison filters.");
  const matchedCount = count(data.matchedCount, "matched count");
  const totalEntries = count(data.totalEntries, "total entries");
  if (matchedCount > totalEntries) throw new Error("The server returned an invalid matched count.");
  const duration = data.durationMilliseconds;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0))
    throw new Error("The server returned an invalid comparison duration.");
  return { session, filters, matchedCount, totalEntries, durationMilliseconds: duration };
}
export function readComparison(value: unknown): ComparisonSnapshot {
  const data = object(value);
  const baseline = readSide(data.baseline);
  const candidate = readSide(data.candidate);
  const processedEntries = count(data.processedEntries, "processed entries");
  const totalEntries = count(data.totalEntries, "comparison total entries");
  if (baseline.session.id === candidate.session.id || processedEntries > totalEntries ||
      !Number.isSafeInteger(baseline.totalEntries + candidate.totalEntries) ||
      totalEntries !== baseline.totalEntries + candidate.totalEntries)
    throw new Error("The server returned inconsistent comparison bounds.");
  return {
    id: identity(data.id, "comparison ID"),
    state: choice(data.state, ["running", "completed", "cancelled", "invalidated", "failed"], "state"),
    phase: text(data.phase, "comparison phase"), processedEntries, totalEntries,
    error: nullableText(data.error, "comparison error"), baseline, candidate,
    grouping: choice(data.grouping, ["normalized", "raw"], "grouping"),
    normalizationRule: text(data.normalizationRule, "normalization rule")
  };
}
function readGroup(value: unknown, kind: ComparisonKind, change: ComparisonChange | "all"): ComparisonGroup {
  const data = object(value);
  const baselineCount = count(data.baselineCount, "baseline count");
  const candidateCount = count(data.candidateCount, "candidate count");
  const actualChange = choice(data.change, ["new", "resolved", "changed", "unchanged"], "change");
  const expectedChange = baselineCount === 0 ? "new" : candidateCount === 0 ? "resolved" :
    baselineCount === candidateCount ? "unchanged" : "changed";
  if ((!baselineCount && !candidateCount) || data.delta !== candidateCount - baselineCount ||
      actualChange !== expectedChange || (change !== "all" && actualChange !== change) || data.kind !== kind)
    throw new Error("The server returned inconsistent comparison group counts.");
  const severity = data.severity === null ? null : choice(data.severity, Severities, "severity");
  return {
    id: identity(data.id, "comparison group ID"), kind, label: text(data.label, "group label"),
    severity, category: nullableText(data.category, "group category"), baselineCount, candidateCount,
    delta: candidateCount - baselineCount, change: actualChange
  };
}
async function request(url: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(url, options);
  const data: unknown = await response.json();
  if (!response.ok) throw new ApiError(text(object(data).error, "comparison error"), response.status);
  return data;
}
export async function startComparison(options: ComparisonOptions): Promise<ComparisonSnapshot> {
  if (!options.baselineId || !options.candidateId || options.baselineId === options.candidateId)
    throw new Error("Choose two distinct completed saved sessions.");
  const snapshot = readComparison(await request("api/comparison", {
    method: "POST", headers: { [ClearActionHeader]: "compare", "Content-Type": "application/json" },
    body: JSON.stringify(options)
  }));
  if (snapshot.baseline.session.id !== options.baselineId || snapshot.candidate.session.id !== options.candidateId ||
      snapshot.grouping !== options.grouping ||
      (options.filterScope === "all" && (snapshot.baseline.filters !== null || snapshot.candidate.filters !== null)))
    throw new Error("The server returned a different comparison.");
  return snapshot;
}
export async function fetchComparison(id: string, signal: AbortSignal): Promise<ComparisonSnapshot> {
  const snapshot = readComparison(await request(`api/comparison?${new URLSearchParams({ id })}`, { signal }));
  if (snapshot.id !== id) throw new Error("The server returned a different comparison.");
  return snapshot;
}
export async function cancelComparison(id: string): Promise<ComparisonSnapshot> {
  const snapshot = readComparison(await request(`api/comparison?${new URLSearchParams({ id })}`, {
    method: "POST", keepalive: true, headers: { [ClearActionHeader]: "cancel-comparison" }
  }));
  if (snapshot.id !== id) throw new Error("The server returned a different comparison.");
  return snapshot;
}
export async function fetchComparisonGroups(id: string, kind: ComparisonKind, change: ComparisonChange | "all",
  offset: number, signal: AbortSignal): Promise<ComparisonGroups> {
  count(offset, "requested offset");
  const data = object(await request(`api/comparison/groups?${new URLSearchParams({ id, kind, change, offset: String(offset) })}`, { signal }));
  const total = count(data.total, "group total");
  if (data.pageSize !== PageSize || data.offset !== offset || !Array.isArray(data.groups) ||
      data.groups.length > PageSize || (data.groups.length > 0 && offset + data.groups.length > total))
    throw new Error("The server returned invalid comparison page bounds.");
  const groups = data.groups.map(value => readGroup(value, kind, change));
  if (new Set(groups.map(group => group.id)).size !== groups.length)
    throw new Error("The server returned duplicate comparison groups.");
  return { groups, total, offset, pageSize: PageSize };
}
export async function fetchComparisonEvidence(id: string, groupId: string, side: ComparisonSideName,
  sessionId: string, after: number, signal: AbortSignal): Promise<ComparisonEvidence> {
  count(after, "evidence cursor");
  const data = object(await request(`api/comparison/evidence?${new URLSearchParams({ id, groupId, side, after: String(after) })}`, { signal }));
  if (data.sessionId !== sessionId || !Array.isArray(data.entries) || data.entries.length > PageSize)
    throw new Error("The server returned invalid comparison evidence.");
  let previous = after;
  const entries = data.entries.map(value => {
    const entry = object(value);
    const entryId = count(entry.id, "evidence entry ID");
    if (entryId <= previous) throw new Error("The server returned an invalid evidence order.");
    previous = entryId;
    return {
      id: entryId, timestamp: timestamp(entry.timestamp, "evidence timestamp"),
      severity: choice(entry.severity, Severities, "evidence severity"), stream: choice(entry.stream, Streams, "evidence stream"),
      category: nullableText(entry.category, "evidence category"), message: text(entry.message, "evidence message"),
      isPartial: boolean(entry.isPartial, "evidence line type")
    };
  });
  const nextAfter = data.nextAfter === null ? null : count(data.nextAfter, "next evidence cursor");
  if (nextAfter !== null && (!entries.length || nextAfter !== previous))
    throw new Error("The server returned an invalid next evidence cursor.");
  return { sessionId, entries, nextAfter };
}
