import type { ComparisonGroup, ComparisonSnapshot } from "./comparison-api";
import type { SessionInfo } from "./model";

export const comparisonSessions: SessionInfo[] = [
  { id: "baseline", name: "Before run", startedAt: "2026-10-11T08:00:00Z", completedAt: "2026-10-11T08:01:00Z", exitCode: 0, entryCount: 900, command: "dotnet", arguments: [], workingDirectory: "/logs", isCurrent: false },
  { id: "candidate", name: "After run", startedAt: "2026-10-12T08:00:00Z", completedAt: "2026-10-12T08:02:00Z", exitCode: 0, entryCount: 950, command: "dotnet", arguments: [], workingDirectory: "/logs", isCurrent: false },
  { id: "current", name: "Current excluded", startedAt: "2026-10-13T08:00:00Z", completedAt: "2026-10-13T08:01:00Z", exitCode: 0, entryCount: 10, command: null, arguments: [], workingDirectory: "", isCurrent: true },
  { id: "unfinished", name: "Unfinished excluded", startedAt: "2026-10-13T08:00:00Z", completedAt: null, exitCode: null, entryCount: 10, command: null, arguments: [], workingDirectory: "", isCurrent: false }
];
export function comparisonSnapshot(changes: Partial<ComparisonSnapshot> = {}): ComparisonSnapshot {
  return {
    id: "comparison/one", state: "completed", phase: "completed", processedEntries: 220, totalEntries: 220, error: null,
    baseline: { session: comparisonSessions[0]!, filters: null, matchedCount: 100, totalEntries: 100, durationMilliseconds: 60000 },
    candidate: { session: comparisonSessions[1]!, filters: null, matchedCount: 120, totalEntries: 120, durationMilliseconds: 120000 },
    grouping: "normalized", normalizationRule: "Replace GUIDs and decimal numbers with placeholders; preserve severity and category.",
    ...changes
  };
}
export function comparisonGroup(changes: Partial<ComparisonGroup> = {}): ComparisonGroup {
  return { id: "group/one", kind: "message", label: "Request <number> failed", severity: "error", category: "Worker",
    baselineCount: 5, candidateCount: 8, delta: 3, change: "changed", ...changes };
}
