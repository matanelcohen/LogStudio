import { ApiError } from "./api";
import { ClearActionHeader } from "./model";
import { validateSourcePatterns, type TelemetrySourcePatterns } from "./telemetry-api";

export interface DiscoveredTelemetrySources {
  meterSources: string[]; activitySources: string[];
  omittedMeterSources: number; omittedActivitySources: number;
}
export interface ProjectSourceFile { name: string; content: string; }
export interface SourceEvidence {
  kind: "meter" | "activity"; source: string; origin: "runtime" | "project";
  file: string | null; line: number | null;
}
export interface TelemetrySourceSuggestion extends TelemetrySourcePatterns {
  explanation: string; evidence: SourceEvidence[]; warnings: string[];
}
export const ProjectFileAccept = ".cs,.csproj,.props,.targets,.json";
export const MaximumProjectFileBytes = 131072;

function invalid(): never { throw new Error("The server returned invalid telemetry source suggestions or discovery."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  return typeof value === "string" && value.length <= maximum ? value : invalid();
}
function array(value: unknown, maximum: number): unknown[] {
  return Array.isArray(value) && value.length <= maximum ? value : invalid();
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}
export function readDiscoveredTelemetrySources(value: unknown): DiscoveredTelemetrySources {
  const data = object(value);
  return {
    meterSources: array(data.meterSources, 256).map(value => text(value, 256)),
    activitySources: array(data.activitySources, 256).map(value => text(value, 256)),
    omittedMeterSources: count(data.omittedMeterSources), omittedActivitySources: count(data.omittedActivitySources)
  };
}
export function readTelemetrySourceSuggestion(value: unknown): TelemetrySourceSuggestion {
  const data = object(value);
  const patterns = { meterSources: text(data.meterSources, 4096), activitySources: text(data.activitySources, 4096) };
  if (validateSourcePatterns(patterns)) return invalid();
  return {
    ...patterns, explanation: text(data.explanation, 4000),
    evidence: array(data.evidence, 128).map(value => {
      const item = object(value);
      if ((item.kind !== "meter" && item.kind !== "activity") || (item.origin !== "runtime" && item.origin !== "project")) return invalid();
      const file = item.file === null ? null : text(item.file, 256);
      const line = item.line === null ? null : count(item.line);
      if ((item.origin === "runtime" && (file !== null || line !== null)) ||
        (item.origin === "project" && (!file || (line !== null && line < 1)))) return invalid();
      return { kind: item.kind, source: text(item.source, 256), origin: item.origin, file, line };
    }),
    warnings: array(data.warnings, 8).map(value => text(value, 512))
  };
}
export function validateProjectFileNames(files: readonly { name: string; size: number }[]): void {
  if (files.length > 8) throw new Error("Select at most 8 approved project files.");
  for (const file of files) {
    if (!file.name || file.name.length > 256 || /[/\\]/.test(file.name) || !/\.(cs|csproj|props|targets|json)$/i.test(file.name))
      throw new Error("Approved files must have a filename of at most 256 characters and end in .cs, .csproj, .props, .targets, or .json.");
    if (file.size > MaximumProjectFileBytes) throw new Error("Each selected file must be at most 131072 bytes before reading.");
  }
}
export function validateProjectSourceFiles(files: readonly ProjectSourceFile[]): void {
  validateProjectFileNames(files.map(file => ({ name: file.name, size: 0 })));
  let total = 0;
  for (const file of files) {
    if (typeof file.content !== "string" || file.content.length > 32768)
      throw new Error("Each approved file must contain at most 32768 characters.");
    total += file.content.length;
  }
  if (total > 65536) throw new Error("Approved files must contain at most 65536 characters in total.");
}
export async function readApprovedProjectFiles(files: readonly File[]): Promise<ProjectSourceFile[]> {
  validateProjectFileNames(files);
  const approved = await Promise.all(files.map(async file => ({ name: file.name, content: await file.text() })));
  validateProjectSourceFiles(approved);
  return approved;
}
export async function fetchDiscoveredTelemetrySources(signal: AbortSignal): Promise<DiscoveredTelemetrySources> {
  const response = await fetch("api/telemetry/sources", { signal });
  if (!response.ok) throw new ApiError(`Could not discover telemetry sources (HTTP ${response.status}).`, response.status);
  return readDiscoveredTelemetrySources(await response.json());
}
export async function suggestTelemetrySources(consent: boolean, projectFiles: readonly ProjectSourceFile[] = [], signal?: AbortSignal): Promise<TelemetrySourceSuggestion> {
  if (consent !== true) throw new Error("Explicit consent is required to suggest telemetry sources.");
  validateProjectSourceFiles(projectFiles);
  const response = await fetch("api/telemetry/suggest", {
    method: "POST", signal, headers: { "Content-Type": "application/json", [ClearActionHeader]: "telemetry-suggest" },
    body: JSON.stringify({ consent: true, projectFiles: projectFiles.map(({ name, content }) => ({ name, content })) })
  });
  if (!response.ok) throw new ApiError(`Could not suggest telemetry sources (HTTP ${response.status}).`, response.status);
  return readTelemetrySourceSuggestion(await response.json());
}
