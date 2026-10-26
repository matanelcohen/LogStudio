import type { LogEntry, LogPage, ViewerStatus } from "./model";
import type { AnalyticsSnapshot } from "./analytics-model";

export const Status: ViewerStatus = {
  applicationName: "React fixture",
  startedAt: "2026-10-11T18:00:00Z",
  capacity: 0, retainedCount: 20000, firstId: 1, lastId: 20000, evictedCount: 0,
  isCompleted: true, completedAt: "2026-10-11T18:01:00Z", exitCode: 0, revision: 20001,
  errorCount: 10, warningCount: 20, journalBytes: 4000000, ioBufferBytes: 131072,
  pendingEntries: 0, flushEveryEntries: 1000, historyDirectory: "/private/temp/logstudio-fixture", clearedThroughId: 0
};

export const Entry: LogEntry = {
  id: 1, timestamp: "2026-10-11T18:00:00Z", stream: "stdout", severity: "information",
  category: "App.Skill", message: "Hello alpha beta", isPartial: false
};

export function fixturePage(entry: LogEntry = Entry): LogPage {
  return {
    entries: [entry], status: Status, matchCount: 1, errorCount: 0, warningCount: 0,
    olderCount: 0, newerCount: 0, categories: [null, "App.Skill"], highlightTerms: ["alpha", "beta"], pageSize: 250
  };
}

export function fixtureAnalytics(): AnalyticsSnapshot {
  return {
    totalCount: 1000, errorCount: 100, warningCount: 50,
    firstTimestamp: "2026-10-11T18:00:00Z", lastTimestamp: "2026-10-11T18:32:00Z",
    timeline: Array.from({ length: 32 }, (_, index) => ({
      since: new Date(Date.parse("2026-10-11T18:00:00Z") + index * 60000).toISOString(),
      until: new Date(Date.parse("2026-10-11T18:00:00Z") + (index + 1) * 60000).toISOString(),
      count: index === 31 ? 1000 : 0, errorCount: index === 31 ? 100 : 0, warningCount: index === 31 ? 50 : 0
    })),
    levels: [{ value: "error", count: 100, errorCount: 100, warningCount: 0 }, { value: "warning", count: 50, errorCount: 0, warningCount: 50 },
      { value: "information", count: 850, errorCount: 0, warningCount: 0 }],
    streams: [{ value: "stdout", count: 1000, errorCount: 100, warningCount: 50 }],
    categories: [{ value: "App.Skill", count: 900, errorCount: 90, warningCount: 50 }, { value: null, count: 100, errorCount: 10, warningCount: 0 }],
    otherCategories: { value: null, count: 0, errorCount: 0, warningCount: 0 }, status: Status
  };
}
