import {
  ApiRoutes, ClearActionHeader, ClearActionValue, DeleteSessionActionValue, ImportActionValue, importFormat, MaximumCategorySuggestions, MaximumHighlights, MaximumPageSize, PageSize, QueryKeys, RenameActionValue, Severities, Streams, UploadContentType, validateImportFile,
  type ClearResult, type LogEntry, type LogPage, type SessionInfo, type ViewerStatus
} from "./model";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value))
    throw new Error("The server returned an invalid object.");
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`The server returned an invalid ${name}.`);
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`The server returned an invalid ${name}.`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`The server returned an invalid ${name}.`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`The server returned an invalid ${name}.`);
  return result;
}

export function readStatus(value: unknown): ViewerStatus {
  const data = object(value);
  const exitCode = data.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)))
    throw new Error("The server returned an invalid exit code.");
  return {
    applicationName: text(data.applicationName, "application name"),
    startedAt: timestamp(data.startedAt, "start time"),
    capacity: count(data.capacity, "capacity"),
    retainedCount: count(data.retainedCount, "retained count"),
    firstId: count(data.firstId, "first ID"),
    lastId: count(data.lastId, "last ID"),
    evictedCount: count(data.evictedCount, "expired count"),
    isCompleted: boolean(data.isCompleted, "completion state"),
    completedAt: data.completedAt === null ? null : timestamp(data.completedAt, "completion time"),
    exitCode,
    revision: count(data.revision, "revision"),
    errorCount: count(data.errorCount, "error count"),
    warningCount: count(data.warningCount, "warning count"),
    journalBytes: count(data.journalBytes, "journal size"),
    ioBufferBytes: count(data.ioBufferBytes, "buffer size"),
    pendingEntries: count(data.pendingEntries, "pending count"),
    flushEveryEntries: count(data.flushEveryEntries, "flush cadence"),
    historyDirectory: text(data.historyDirectory, "history directory"),
    clearedThroughId: count(data.clearedThroughId, "clear checkpoint")
  };
}

function readEntry(value: unknown): LogEntry {
  const data = object(value);
  const severity = Severities.find(candidate => candidate === data.severity);
  const stream = Streams.find(candidate => candidate === data.stream);
  if (severity === undefined || stream === undefined) throw new Error("The server returned an invalid log level or stream.");
  return {
    id: count(data.id, "entry ID"),
    timestamp: timestamp(data.timestamp, "capture time"),
    severity, stream,
    category: nullableText(data.category, "category"),
    message: text(data.message, "message"),
    isPartial: boolean(data.isPartial, "line type")
  };
}

export function readPage(value: unknown, requestedPageSize = PageSize): LogPage {
  const data = object(value);
  const pageSize = count(data.pageSize, "page size");
  if (pageSize < 1 || pageSize > MaximumPageSize || pageSize !== requestedPageSize)
    throw new Error("The server returned an invalid page size.");
  if (!Array.isArray(data.entries) || data.entries.length > pageSize)
    throw new Error("The server returned more than one page of log entries.");
  if (!Array.isArray(data.categories) || data.categories.length > MaximumCategorySuggestions)
    throw new Error("The server returned too many category suggestions.");
  if (!Array.isArray(data.highlightTerms) || data.highlightTerms.length > MaximumHighlights)
    throw new Error("The server returned invalid highlight terms.");
  return {
    entries: data.entries.map(readEntry),
    status: readStatus(data.status),
    matchCount: count(data.matchCount, "match count"),
    errorCount: count(data.errorCount, "error count"),
    warningCount: count(data.warningCount, "warning count"),
    olderCount: count(data.olderCount, "older count"),
    newerCount: count(data.newerCount, "newer count"),
    categories: data.categories.map(value => nullableText(value, "category suggestion")),
    highlightTerms: data.highlightTerms.map(value => text(value, "highlight term")),
    pageSize
  };
}

export async function fetchPage(parameters: URLSearchParams, signal: AbortSignal): Promise<LogPage> {
  const response = await fetch(`${ApiRoutes.Search}?${parameters}`, { signal });
  const value: unknown = await response.json();
  if (!response.ok) {
    const data = object(value);
    throw new ApiError(text(data.error, "query error"), response.status);
  }
  return readPage(value, Number(parameters.get(QueryKeys.PageSize) ?? PageSize));
}

export async function clearSessionLogs(sessionId = ""): Promise<ClearResult> {
  const query = sessionId ? `?${new URLSearchParams({ [QueryKeys.SessionId]: sessionId })}` : "";
  const response = await fetch(ApiRoutes.Clear + query, {
    method: "POST",
    headers: { [ClearActionHeader]: ClearActionValue }
  });
  const data = object(await response.json());
  if (!response.ok) throw new ApiError(text(data.error, "clear error"), response.status);
  return { deletedCount: count(data.deletedCount, "deleted count"), status: readStatus(data.status) };
}

export async function fetchSessions(signal: AbortSignal): Promise<SessionInfo[]> {
  const response = await fetch(ApiRoutes.Sessions, { signal });
  const value: unknown = await response.json();
  if (!response.ok) throw new ApiError(text(object(value).error, "sessions error"), response.status);
  if (!Array.isArray(value)) throw new Error("The server returned an invalid session list.");
  return value.map(readSessionInfo);
}

export function readSessionInfo(value: unknown): SessionInfo {
  const data = object(value);
  if (!Array.isArray(data.arguments) || data.arguments.some(value => typeof value !== "string"))
    throw new Error("The server returned invalid run arguments.");
  const exitCode = data.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))) throw new Error("Invalid session exit code.");
  return {
    id: text(data.id, "session ID"), name: text(data.name, "session name"),
    startedAt: timestamp(data.startedAt, "session date"),
    completedAt: data.completedAt === null ? null : timestamp(data.completedAt, "session completion"),
    exitCode, entryCount: count(data.entryCount, "session entry count"),
    command: nullableText(data.command, "run command"), arguments: data.arguments.map(value => text(value, "argument")),
    workingDirectory: text(data.workingDirectory, "working directory"), isCurrent: boolean(data.isCurrent, "current session")
  };
}

export function importSessionFile(file: File, name: string, onProgress: (percent: number) => void): Promise<SessionInfo> {
  const invalid = validateImportFile(file);
  const format = importFormat(file.name);
  if (invalid || !format) return Promise.reject(new Error(invalid ?? "Unsupported import format."));
  const parameters = new URLSearchParams({ format });
  if (name.trim()) parameters.set("name", name.trim());
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${ApiRoutes.Import}?${parameters}`);
    request.responseType = "json";
    request.setRequestHeader(ClearActionHeader, ImportActionValue);
    request.setRequestHeader("Content-Type", UploadContentType);
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    request.onerror = () => reject(new Error("The upload connection failed. Check the Sessions list before retrying."));
    request.onabort = () => reject(new Error("The upload was interrupted."));
    request.onload = () => {
      try {
        const value: unknown = request.response;
        if (request.status < 200 || request.status >= 300)
          throw new ApiError(text(object(value).error, "import error"), request.status);
        resolve(readSessionInfo(value));
      } catch (error) {
        reject(error);
      }
    };
    request.send(file);
  });
}

async function manageSession(id: string, action: string, name?: string): Promise<unknown> {
  const response = await fetch(`${ApiRoutes.Sessions}?${new URLSearchParams({ [QueryKeys.SessionId]: id })}`, {
    method: "POST",
    headers: { [ClearActionHeader]: action, ...(name !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: name !== undefined ? JSON.stringify({ name }) : undefined
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new ApiError(text(object(value).error, "session action error"), response.status);
  return value;
}

export async function renameSession(id: string, name: string): Promise<SessionInfo> {
  return readSessionInfo(await manageSession(id, RenameActionValue, name));
}

export async function deleteSession(id: string): Promise<void> {
  const result = object(await manageSession(id, DeleteSessionActionValue));
  if (result.deleted !== true) throw new Error("The server did not confirm deletion.");
}
