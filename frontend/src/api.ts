import {
  ApiRoutes, ClearActionHeader, ClearActionValue, ConditionFields, ConditionModes, ConditionOperators, CopilotChatActionValue, CopilotClearHistoryActionValue, CopilotConnectActionValue, DeleteSessionActionValue, ImportActionValue, importFormat, IncludeModes, MaximumCategorySuggestions, MaximumChatAnswerLength, MaximumChatRequestBytes, MaximumHighlights, MaximumPageSize, PageSize, QueryKeys, readChoice, RenameActionValue, SaveFiltersActionValue, Severities, Streams, UploadContentType, validateConditions, validateImportFile,
  InputActionValue, MaximumInputLength, SelectApplicationActionValue, type RunningApplication, type RunningApplicationProcess, type RunningApplicationsState,
  type ChatMessage, type ChatOptions, type ChatResponse, type CopilotConnection, type ClearResult, type LogEntry, type LogPage, type SessionFilters, type SessionInfo, type ViewerStatus
} from "./model";
import { readPreferences, type PreferencesChanges } from "./preferences";

export async function appSettings(changes?: PreferencesChanges, signal?: AbortSignal) {
  const response = await fetch("api/settings", changes
    ? { method: "POST", headers: { [ClearActionHeader]: "save-settings", "Content-Type": "application/json" }, body: JSON.stringify(changes), keepalive: true }
    : { signal });
  const data = object(await response.json());
  if (!response.ok) throw new ApiError(text(data.error, "settings error"), response.status);
  return { preferences: readPreferences(data.preferences), hasPreferences: boolean(data.hasPreferences, "saved settings state") };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AppRelease {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
}

export interface AppUpdateState {
  currentVersion: string;
  automaticCheck: boolean;
  release: AppRelease | null;
  updateAvailable: boolean;
  installationUnavailableReason: string | null;
  installedVersion: string | null;
}

export async function appUpdate(action?: "check-update" | "install-update", version?: string): Promise<AppUpdateState> {
  const query = version ? `?${new URLSearchParams({ version })}` : "";
  const response = await fetch(`api/app-update${query}`, action
    ? { method: "POST", headers: { [ClearActionHeader]: action } }
    : undefined);
  const data = object(await response.json());
  if (!response.ok) throw new ApiError(text(data.error, "update error"), response.status);
  let release: AppRelease | null = null;
  if (data.release !== null) {
    const value = object(data.release);
    const version = text(value.version, "release version");
    const url = text(value.url, "release URL");
    const notes = text(value.notes, "release notes");
    if (!/^\d+\.\d+\.\d+$/.test(version) || url !== `https://github.com/matanelcohen/LogStudio/releases/tag/${version}` || notes.length > 65536)
      throw new Error("The server returned invalid release metadata.");
    release = { version, url, notes, name: text(value.name, "release name"), publishedAt: timestamp(value.publishedAt, "release date") };
  }
  return {
    currentVersion: text(data.currentVersion, "current version"),
    automaticCheck: boolean(data.automaticCheck, "automatic update check"),
    release,
    updateAvailable: boolean(data.updateAvailable, "update availability"),
    installationUnavailableReason: nullableText(data.installationUnavailableReason, "installation availability"),
    installedVersion: nullableText(data.installedVersion, "installed update")
  };
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
    listenAll: data.listenAll === undefined ? false : boolean(data.listenAll, "application selection mode"),
    canWriteInput: data.canWriteInput === undefined ? false : boolean(data.canWriteInput, "terminal input availability"),
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

function readApplicationProcess(value: unknown): RunningApplicationProcess {
  const data = object(value);
  const processId = count(data.processId, "process ID");
  const startedAtTicks = text(data.startedAtTicks, "process start identity");
  if (processId === 0 || !/^[1-9]\d{0,18}$/.test(startedAtTicks))
    throw new Error("The server returned an invalid process identity.");
  return {
    processId, name: text(data.name, "application name"), startedAtTicks,
    ...(data.path === undefined ? {} : { path: nullableText(data.path, "application path") })
  };
}

function readApplication(value: unknown): RunningApplication {
  const data = object(value);
  if (data.processes !== undefined && data.processes !== null && !Array.isArray(data.processes))
    throw new Error("The server returned an invalid application process list.");
  return {
    ...readApplicationProcess(data),
    ...(data.groupId === undefined ? {} : { groupId: nullableText(data.groupId, "application group") }),
    ...(data.processes === undefined || data.processes === null ? {} : { processes: data.processes.map(readApplicationProcess) }),
    ...(data.isTool === undefined ? {} : { isTool: boolean(data.isTool, "application tooling flag") })
  };
}

function readApplications(value: unknown): RunningApplicationsState {
  const data = object(value);
  if (!Array.isArray(data.applications)) throw new Error("The server returned an invalid application list.");
  return {
    applications: data.applications.map(readApplication),
    selected: data.selected === null ? null : readApplication(data.selected),
    error: nullableText(data.error, "application error")
  };
}

export async function fetchApplications(signal: AbortSignal): Promise<RunningApplicationsState> {
  const response = await fetch(ApiRoutes.Applications, { signal });
  const data: unknown = await response.json();
  if (!response.ok) throw new ApiError(text(object(data).error, "application list error"), response.status);
  return readApplications(data);
}

export async function selectApplication(application: RunningApplication): Promise<RunningApplicationsState> {
  const parameters = new URLSearchParams({ processId: String(application.processId), startedAtTicks: application.startedAtTicks });
  if (application.groupId) parameters.set("scope", "application");
  const response = await fetch(`${ApiRoutes.Applications}?${parameters}`, {
    method: "POST", headers: { [ClearActionHeader]: SelectApplicationActionValue }
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new ApiError(text(object(data).error, "application selection error"), response.status);
  return readApplications(data);
}

export async function sendInput(textValue: string): Promise<void> {
  if (textValue.length > MaximumInputLength || /[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(textValue))
    throw new Error("Send a single line of up to 4096 characters without control characters (tabs are allowed).");
  const response = await fetch(ApiRoutes.Input, {
    method: "POST",
    headers: { [ClearActionHeader]: InputActionValue, "Content-Type": "application/json" },
    body: JSON.stringify({ text: textValue })
  });
  const data = object(await response.json());
  if (!response.ok) throw new ApiError(text(data.error, "input error"), response.status);
  if (data.sent !== true) throw new Error("The server did not confirm that input was sent.");
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
    workingDirectory: text(data.workingDirectory, "working directory"), isCurrent: boolean(data.isCurrent, "current session"),
    ...(data.filters == null ? {} : { filters: readSessionFilters(data.filters) })
  };
}

export function readSessionFilters(value: unknown): SessionFilters {
  const data = object(value);
  if (data.levels !== null && (!Array.isArray(data.levels) || data.levels.length > Severities.length))
    throw new Error("The server returned invalid saved levels.");
  if (!Array.isArray(data.conditions)) throw new Error("The server returned invalid saved conditions.");
  const conditions = data.conditions.map(value => {
    const condition = object(value);
    return {
      mode: readChoice(text(condition.mode, "condition mode"), ConditionModes),
      field: readChoice(text(condition.field, "condition field"), ConditionFields),
      operator: readChoice(text(condition.operator, "condition operator"), ConditionOperators),
      value: text(condition.value, "condition value")
    };
  });
  if (validateConditions(conditions)) throw new Error("The server returned invalid saved conditions.");
  const search = text(data.search, "saved search");
  const category = text(data.category, "saved category");
  if (search.length > 1024) throw new Error("The server returned an oversized saved search.");
  if (category) {
    const label = nullableText(JSON.parse(category), "saved category");
    if (label !== null && label.length > 512) throw new Error("The server returned an oversized saved category.");
  }
  const timeWindow = count(data.timeWindow, "saved time window");
  if (![0, 60000, 300000, 900000].includes(timeWindow)) throw new Error("The server returned an invalid saved time window.");
  return {
    search, matchCase: boolean(data.matchCase, "saved case setting"),
    severity: readChoice(text(data.severity, "saved severity"), ["all", "warningPlus", "errorPlus", ...Severities]),
    levels: data.levels === null ? null : (data.levels as unknown[]).map(value => readChoice(text(value, "saved level"), Severities)),
    stream: readChoice(text(data.stream, "saved stream"), ["all", ...Streams]),
    category, timeWindow, conditions,
    includeMode: readChoice(text(data.includeMode, "saved include mode"), IncludeModes)
  };
}

export async function saveSessionFilters(id: string, filters: SessionFilters): Promise<void> {
  const response = await fetch(`${ApiRoutes.Sessions}?${new URLSearchParams({ [QueryKeys.SessionId]: id })}`, {
    method: "POST", keepalive: true,
    headers: { [ClearActionHeader]: SaveFiltersActionValue, "Content-Type": "application/json" },
    body: JSON.stringify({ filters })
  });
  if (!response.ok) throw new ApiError(text(object(await response.json()).error, "filter save error"), response.status);
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

export async function fetchCopilotHistory(sessionId: string, signal: AbortSignal): Promise<ChatMessage[]> {
  const query = sessionId ? `?${new URLSearchParams({ [QueryKeys.SessionId]: sessionId })}` : "";
  const response = await fetch(ApiRoutes.CopilotHistory + query, { signal });
  const value: unknown = await response.json();
  if (!response.ok) throw new ApiError(text(object(value).error, "chat history error"), response.status);
  if (!Array.isArray(value) || value.length % 2 !== 0) throw new Error("The server returned invalid chat history.");
  return value.map((value, index) => {
    const message = object(value);
    const role = index % 2 === 0 ? "user" : "assistant";
    if (message.role !== role) throw new Error("The server returned an invalid chat message role.");
    return { role, content: text(message.content, "chat message") };
  });
}

export async function clearCopilotHistory(sessionId: string): Promise<void> {
  const query = sessionId ? `?${new URLSearchParams({ [QueryKeys.SessionId]: sessionId })}` : "";
  const response = await fetch(ApiRoutes.CopilotHistory + query, {
    method: "POST", headers: { [ClearActionHeader]: CopilotClearHistoryActionValue }
  });
  if (!response.ok) throw new ApiError(text(object(await response.json()).error, "chat history clear error"), response.status);
}

export async function connectCopilot(): Promise<CopilotConnection> {
  const response = await fetch(ApiRoutes.CopilotConnect, {
    method: "POST", headers: { [ClearActionHeader]: CopilotConnectActionValue }
  });
  const data = object(await response.json());
  if (!response.ok) throw new ApiError(text(data.error, "Copilot connection error"), response.status);
  if (!Array.isArray(data.models)) throw new Error("The server returned an invalid Copilot model list.");
  return {
    version: text(data.version, "Copilot version"),
    models: data.models.map(value => {
      const model = object(value);
      if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.some(effort => typeof effort !== "string"))
        throw new Error("The server returned invalid reasoning levels.");
      return { id: text(model.id, "model ID"), name: text(model.name, "model name"), reasoningEfforts: model.reasoningEfforts as string[] };
    })
  };
}

export async function askCopilot(sessionId: string, question: string, messages: ChatMessage[], options: ChatOptions = {},
  onUpdate?: (answer: string) => void): Promise<ChatResponse> {
  const query = sessionId ? `?${new URLSearchParams({ [QueryKeys.SessionId]: sessionId })}` : "";
  let history = messages;
  let body = JSON.stringify({ question, messages: history, ...options });
  while (history.length > 0 && new TextEncoder().encode(body).length > MaximumChatRequestBytes) {
    history = history.slice(2);
    body = JSON.stringify({ question, messages: history, ...options });
  }
  const response = await fetch(ApiRoutes.CopilotChat + query, {
    method: "POST",
    headers: { [ClearActionHeader]: CopilotChatActionValue, "Content-Type": "application/json", ...(onUpdate ? { Accept: "application/x-ndjson" } : {}) },
    body
  });
  if (!response.ok) throw new ApiError(text(object(await response.json()).error, "Copilot chat error"), response.status);
  if (onUpdate && response.headers?.get("Content-Type")?.startsWith("application/x-ndjson")) {
    if (!response.body) throw new Error("Copilot returned an empty response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let result: ChatResponse | null = null;
    try {
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          if (newline > MaximumChatAnswerLength * 8) throw new Error("Copilot returned an oversized stream event.");
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const event = object(JSON.parse(line));
          if (event.error !== undefined) throw new Error(text(event.error, "Copilot chat error"));
          if (event.answer !== undefined) result = readChatResponse(event);
          else {
            const answer = text(event.content, "Copilot streamed answer");
            if (answer.length > MaximumChatAnswerLength) throw new Error("Copilot's response exceeded the character limit.");
            onUpdate(answer);
          }
          if (pending.length > MaximumChatAnswerLength * 8) throw new Error("Copilot returned an oversized stream event.");
        }
        if (chunk.done) break;
      }
      if (!result || pending.trim()) throw new Error("The Copilot response stream was interrupted. Try again.");
      return result;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return readChatResponse(object(await response.json()));
}

function readChatResponse(data: Record<string, unknown>): ChatResponse {
  const answer = text(data.answer, "Copilot answer");
  const contextEntryCount = count(data.contextEntryCount, "Copilot context count");
  if (!answer.trim() || answer.length > MaximumChatAnswerLength || contextEntryCount < 1)
    throw new Error("The server returned an invalid Copilot response.");
  return { answer, contextEntryCount, contextTruncated: boolean(data.contextTruncated, "Copilot context truncation") };
}
