import type { LogEntry, LogPage, ViewerStatus } from "./model";

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
    sessionId: "11111111111111111111111111111111",
    entries: [entry], status: Status, matchCount: 1, errorCount: 0, warningCount: 0,
    olderCount: 0, newerCount: 0, categories: [null, "App.Skill"], highlightTerms: ["alpha", "beta"], pageSize: 250
  };
}
