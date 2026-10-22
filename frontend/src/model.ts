export const PageSize = 250;
export const MaximumPageSize = 2_147_483_647;
export const ClearActionHeader = "X-Log-Studio-Action";
export const ClearActionValue = "clear";
export const ImportActionValue = "import";
export const RenameActionValue = "rename";
export const SaveFiltersActionValue = "save-filters";
export const DeleteSessionActionValue = "delete";
export const CopilotConnectActionValue = "copilot-connect";
export const CopilotChatActionValue = "copilot-chat";
export const CopilotClearHistoryActionValue = "copilot-clear-history";
export const TelemetryConfigureActionValue = "telemetry-configure";
export const SelectApplicationActionValue = "select-application";
export const InputActionValue = "input";
export const MaximumInputLength = 4096;
export const MaximumChatQuestionLength = 2000;
export const MaximumChatAnswerLength = 16000;
export const MaximumChatRequestBytes = 32768;
export const MaximumImportBytes = 256 * 1024 * 1024;
export const MaximumSessionNameLength = 128;
export const UploadContentType = "application/octet-stream";
export const QueryDelayMs = 150;
export const MaximumConditions = 16;
export const MaximumConditionValueLength = 256;
export const MaximumConditionsJsonLength = 4096;
export const MaximumCategorySuggestions = 1024;
export const MaximumHighlights = 80;
export const ApiRoutes = { Applications: "api/applications", Input: "api/input", Search: "api/search", Updates: "api/updates", Export: "api/export", Clear: "api/clear", Sessions: "api/sessions", Import: "api/import", SessionExport: "api/export-session", CopilotConnect: "api/copilot/connect", CopilotChat: "api/copilot/chat", CopilotHistory: "api/copilot/history", Telemetry: "api/telemetry", TelemetrySettings: "api/telemetry/settings" } as const;
export const LiveStatusEvent = "status";
export const QueryKeys = {
  Search: "q", MatchCase: "matchCase", Severity: "severity", Stream: "stream", Category: "category",
  Since: "since", MinimumId: "minId", MaximumId: "maxId", Conditions: "filters", IncludeMode: "includeMode",
  Before: "before", After: "after", PageSize: "pageSize", Levels: "levels", SessionId: "sessionId"
} as const;

export const Severities = ["output", "trace", "debug", "information", "warning", "error", "critical"] as const;
export type Severity = typeof Severities[number];
export const Streams = ["stdout", "stderr", "viewer"] as const;
export type LogStream = typeof Streams[number];
export const ConditionModes = ["include", "exclude"] as const;
export type ConditionMode = typeof ConditionModes[number];
export const ConditionFields = ["message", "category", "level", "stream", "id"] as const;
export type ConditionField = typeof ConditionFields[number];
export const ConditionOperators = ["contains", "equals", "startsWith", "endsWith", "regex"] as const;
export type ConditionOperator = typeof ConditionOperators[number];
export const IncludeModes = ["all", "any"] as const;
export type IncludeMode = typeof IncludeModes[number];
export type ConnectionState = "connecting" | "live" | "reconnecting" | "paused" | "failed";

export interface LogEntry {
  id: number;
  timestamp: string;
  stream: LogStream;
  severity: Severity;
  category: string | null;
  message: string;
  isPartial: boolean;
}

export interface ViewerStatus {
  listenAll?: boolean;
  canWriteInput?: boolean;
  applicationName: string;
  startedAt: string;
  capacity: number;
  retainedCount: number;
  firstId: number;
  lastId: number;
  evictedCount: number;
  isCompleted: boolean;
  completedAt: string | null;
  exitCode: number | null;
  revision: number;
  errorCount: number;
  warningCount: number;
  journalBytes: number;
  ioBufferBytes: number;
  pendingEntries: number;
  flushEveryEntries: number;
  historyDirectory: string;
  clearedThroughId: number;
}

export interface RunningApplication {
  processId: number;
  name: string;
  startedAtTicks: string;
}

export interface RunningApplicationsState {
  applications: RunningApplication[];
  selected: RunningApplication | null;
  error: string | null;
}

export interface LogPage {
  entries: LogEntry[];
  status: ViewerStatus;
  matchCount: number;
  errorCount: number;
  warningCount: number;
  olderCount: number;
  newerCount: number;
  categories: (string | null)[];
  highlightTerms: string[];
  pageSize: number;
}

export interface ClearResult {
  deletedCount: number;
  status: ViewerStatus;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CopilotModel {
  id: string;
  name: string;
  reasoningEfforts: string[];
}

export interface CopilotConnection {
  version: string;
  models: CopilotModel[];
}

export interface ChatOptions {
  model?: string;
  reasoningEffort?: string;
}

export interface ChatResponse {
  answer: string;
  contextEntryCount: number;
  contextTruncated: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  entryCount: number;
  command: string | null;
  arguments: string[];
  workingDirectory: string;
  isCurrent: boolean;
  filters?: SessionFilters | null;
}

export type ImportFormat = "bundle" | "jsonl";

export function importFormat(fileName: string): ImportFormat | null {
  const name = fileName.toLowerCase();
  if (name.endsWith(".zip")) return "bundle";
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "jsonl";
  return null;
}

export function validateImportFile(file: { name: string; size: number }): string | null {
  if (!importFormat(file.name)) return "Choose a .logstudio.zip, .zip, .jsonl, or .ndjson file.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MaximumImportBytes) return "Imports are limited to 256 MiB per file.";
  return null;
}

export interface LogCondition {
  mode: ConditionMode;
  field: ConditionField;
  operator: ConditionOperator;
  value: string;
}

export interface QueryState {
  search: string;
  matchCase: boolean;
  severity: string;
  levels: Severity[] | null;
  stream: string;
  category: string;
  timeWindow: number;
  conditions: LogCondition[];
  includeMode: IncludeMode;
  dismissedThrough: number;
  pageSize: number;
  sessionId: string;
}

export type SessionFilters = Pick<QueryState,
  "search" | "matchCase" | "severity" | "levels" | "stream" | "category" | "timeWindow" | "conditions" | "includeMode">;

export function sessionFilters(query: QueryState): SessionFilters {
  const { search, matchCase, severity, levels, stream, category, timeWindow, conditions, includeMode } = query;
  return { search, matchCase, severity, levels, stream, category, timeWindow, conditions, includeMode };
}

export interface PageCursor {
  before: number | null;
  after: number | null;
}

export interface Notice {
  message: string;
  tone: "info" | "warning" | "danger";
}

export const SeverityLabels: Record<Severity, string> = {
  output: "Output", trace: "Trace", debug: "Debug", information: "Info",
  warning: "Warn", error: "Error", critical: "Critical"
};

export const FieldLabels: Record<ConditionField, string> = {
  message: "Message", category: "Category", level: "Level", stream: "Stream", id: "Sequence ID"
};

export const OperatorLabels: Record<ConditionOperator, string> = {
  contains: "contains", equals: "equals", startsWith: "starts with", endsWith: "ends with", regex: "matches regex"
};

export const NumberFormatter = new Intl.NumberFormat();
export const TimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false
});

export function defaultQuery(): QueryState {
  return {
    search: "", matchCase: false, severity: "all", levels: null, stream: "all", category: "", timeWindow: 0,
    conditions: [], includeMode: "all", dismissedThrough: 0, pageSize: PageSize, sessionId: ""
  };
}

export function readChoice<T extends string>(value: string, choices: readonly T[]): T {
  const choice = choices.find(candidate => candidate === value);
  if (choice === undefined) throw new Error(`Unsupported control value: ${value}`);
  return choice;
}

export function validateConditions(conditions: LogCondition[]): string | null {
  if (conditions.length > MaximumConditions) return "Use no more than 16 conditions.";
  if (conditions.some(condition => condition.value.length === 0 || condition.value.length > MaximumConditionValueLength))
    return "Every condition needs a value containing 1–256 characters.";
  if (JSON.stringify(conditions).length > MaximumConditionsJsonLength)
    return "Keep the combined filter definition within 4096 characters.";
  return null;
}

export function buildQueryParameters(query: QueryState, cursor: PageCursor, maximumId: number | null, now = Date.now()): URLSearchParams {
  const parameters = new URLSearchParams();
  parameters.set(QueryKeys.PageSize, String(query.pageSize));
  if (query.sessionId) parameters.set(QueryKeys.SessionId, query.sessionId);
  if (query.search) parameters.set(QueryKeys.Search, query.search);
  if (query.matchCase) parameters.set(QueryKeys.MatchCase, "true");
  if (query.levels !== null) parameters.set(QueryKeys.Levels, JSON.stringify(query.levels));
  else if (query.severity !== "all") parameters.set(QueryKeys.Severity, query.severity);
  if (query.stream !== "all") parameters.set(QueryKeys.Stream, query.stream);
  if (query.category) parameters.set(QueryKeys.Category, query.category);
  if (query.timeWindow) parameters.set(QueryKeys.Since, new Date(now - query.timeWindow).toISOString());
  if (query.dismissedThrough) parameters.set(QueryKeys.MinimumId, String(query.dismissedThrough));
  if (maximumId !== null) parameters.set(QueryKeys.MaximumId, String(maximumId));
  if (query.conditions.length) {
    parameters.set(QueryKeys.Conditions, JSON.stringify(query.conditions));
    parameters.set(QueryKeys.IncludeMode, query.includeMode);
  }
  if (cursor.before !== null) parameters.set(QueryKeys.Before, String(cursor.before));
  if (cursor.after !== null) parameters.set(QueryKeys.After, String(cursor.after));
  return parameters;
}

export function buildExportUrl(query: QueryState, maximumId: number): string {
  return `${ApiRoutes.Export}?${buildQueryParameters(query, { before: null, after: null }, maximumId)}`;
}

export function buildSessionExportUrl(sessionId = ""): string {
  return ApiRoutes.SessionExport + (sessionId ? `?${new URLSearchParams({ [QueryKeys.SessionId]: sessionId })}` : "");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
