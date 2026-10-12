import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./model";
import type { TelemetrySourcePatterns } from "./telemetry-api";
import {
  fetchDiscoveredTelemetrySources, ProjectFileAccept, readApprovedProjectFiles, suggestTelemetrySources,
  type DiscoveredTelemetrySources, type ProjectSourceFile, type TelemetrySourceSuggestion
} from "./telemetry-suggestions-api";

export function TelemetrySourceSuggestions({ disabled, onUse }: { disabled: boolean; onUse: (patterns: TelemetrySourcePatterns) => void }) {
  const [sources, setSources] = useState<DiscoveredTelemetrySources | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [consent, setConsent] = useState(false);
  const [files, setFiles] = useState<ProjectSourceFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [readingFiles, setReadingFiles] = useState(false);
  const [suggestion, setSuggestion] = useState<TelemetrySourceSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const suggestionRequest = useRef<AbortController | null>(null);
  const selectionVersion = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; selectionVersion.current++; suggestionRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDiscovering(true); setDiscoveryError(null);
    void fetchDiscoveredTelemetrySources(controller.signal).then(value => {
      if (!controller.signal.aborted) setSources(value);
    }).catch(error => {
      if (!controller.signal.aborted) setDiscoveryError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setDiscovering(false);
    });
    return () => controller.abort();
  }, [refresh]);

  async function selectFiles(selected: File[]) {
    const version = ++selectionVersion.current;
    setFiles([]); setFileError(null); setReadingFiles(true);
    try {
      const approved = await readApprovedProjectFiles(selected);
      if (mounted.current && version === selectionVersion.current) setFiles(approved);
    } catch (error) {
      if (mounted.current && version === selectionVersion.current) setFileError(errorMessage(error));
    } finally {
      if (mounted.current && version === selectionVersion.current) setReadingFiles(false);
    }
  }

  function clearFiles() {
    selectionVersion.current++; setFiles([]); setFileError(null); setReadingFiles(false);
  }

  async function suggest() {
    if (disabled || !consent || readingFiles || fileError || suggesting || suggestionRequest.current) return;
    const controller = new AbortController();
    suggestionRequest.current = controller;
    setSuggesting(true); setSuggestion(null); setSuggestionError(null);
    try {
      const result = await suggestTelemetrySources(consent, files, controller.signal);
      if (!controller.signal.aborted) setSuggestion(result);
    } catch (error) {
      if (!controller.signal.aborted) setSuggestionError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) { suggestionRequest.current = null; setSuggesting(false); }
    }
  }

  return <>
    <section aria-labelledby="discovered-sources-title">
      <h3 id="discovered-sources-title">Discovered runtime sources</h3>
      <p>Includes discovered source names excluded by the current capture filters when telemetry was enabled at startup. A meter is discovered only after an instrument is published.
        Refresh to see newly created sources; this is not an exhaustive list of future sources. Completed applications may show frozen discovered names.</p>
      <button type="button" disabled={discovering} onClick={() => setRefresh(value => value + 1)}>Refresh sources</button>
      {discovering && <p role="status">Discovering runtime sources…</p>}
      {discoveryError && <p role="alert" className="notice danger">{discoveryError}</p>}
      {sources && <div className="telemetry-source-list">
        <h4>Meter sources</h4>
        {sources.meterSources.length ? <ul>{sources.meterSources.map((source, index) => <li key={index}>{source}</li>)}</ul> : <p>No meter sources discovered.</p>}
        {!!sources.omittedMeterSources && <p>{sources.omittedMeterSources} meter source discovery notifications omitted (may repeat).</p>}
        <h4>Activity sources</h4>
        {sources.activitySources.length ? <ul>{sources.activitySources.map((source, index) => <li key={index}>{source}</li>)}</ul> : <p>No activity sources discovered.</p>}
        {!!sources.omittedActivitySources && <p>{sources.omittedActivitySources} activity source discovery notifications omitted (may repeat).</p>}
      </div>}
    </section>
    <section aria-labelledby="suggest-sources-title">
      <h3 id="suggest-sources-title">Optional AI source suggestions</h3>
      <p>Uses Copilot with your current CLI login. No automatic request is made. Published applications can suggest from runtime sources without project files.</p>
      <p>Project extraction recognizes literal .cs Meter/ActivitySource constructions and AddMeter/AddSource calls, plus JSON meterSources/activitySources arrays.
        XML project files are accepted but not analyzed; dynamically computed names, comments, raw strings, and interpolated strings are not analyzed.
        C# scanning stops at the first interpolated string, so later declarations may be omitted.</p>
      <p>Namespace and source identifiers can reveal application information; sanitization is not exhaustive secret redaction. Do not put credentials or secrets in source names, and select only files you are authorized to submit.</p>
      <label><input type="checkbox" checked={consent} disabled={disabled || suggesting}
        onChange={event => setConsent(event.target.checked)} /> I consent to ask Copilot for source suggestions. Copilot receives only sanitized runtime source identifiers and literal instrumentation identifier evidence extracted from approved files. Selected files are submitted to the local server for deterministic instrumentation-only extraction; no raw project content, filenames, logs, environment values, or unrelated configuration values are sent to the model. Authenticated Copilot may use network access.</label>
      <p>Optional: explicitly choose only files you approve submitting to the local server. No disk scan or arbitrary project path is used.
        Maximum 8 files; 32768 characters each, 65536 characters total; files over 131072 bytes are rejected before reading.</p>
      <label>Approved project files <input aria-label="Approved project files" type="file" multiple accept={ProjectFileAccept}
        disabled={disabled || suggesting} onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void selectFiles(selected); }} /></label>
      {readingFiles && <p role="status">Validating approved files locally…</p>}
      {files.length > 0 && <ul>{files.map((file, index) => <li key={index}>{file.name} ({file.content.length} characters)
        <button type="button" disabled={disabled || suggesting} aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, item) => item !== index))}>Remove</button></li>)}</ul>}
      {(files.length > 0 || fileError || readingFiles) && <button type="button" disabled={disabled || suggesting} onClick={clearFiles}>Clear approved files</button>}
      {fileError && <p role="alert" className="notice danger">{fileError} No files will be submitted until the selection is valid or cleared.</p>}
      <button type="button" disabled={disabled || !consent || suggesting || readingFiles || !!fileError} onClick={() => void suggest()}>Suggest sources</button>
      {suggesting && <p role="status">Requesting source suggestions… Manual drafts remain unchanged.</p>}
      {suggestionError && <p role="alert" className="notice danger">{suggestionError}</p>}
      {suggestion && <section aria-labelledby="review-suggestion-title" className="telemetry-suggestion-preview">
        <h3 id="review-suggestion-title">Review suggestion</h3>
        <p>{suggestion.explanation}</p>
        <dl><dt>Suggested meter patterns</dt><dd>{suggestion.meterSources || "(capture none)"}</dd>
          <dt>Suggested activity patterns</dt><dd>{suggestion.activitySources || "(capture none)"}</dd></dl>
        <h4>Identifier evidence</h4>
        <ul>{suggestion.evidence.map((item, index) => <li key={index}>{item.kind}: {item.source} — {item.origin}
          {item.file !== null && <>: {item.file}{item.line !== null && `:${item.line}`}</>}</li>)}</ul>
        {suggestion.warnings.length > 0 && <><h4>Warnings</h4><ul>{suggestion.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></>}
        <p>Using this suggestion explicitly replaces both editable draft fields. Capture changes only after you click Apply.</p>
        <button type="button" disabled={disabled} onClick={() => onUse({ meterSources: suggestion.meterSources, activitySources: suggestion.activitySources })}>Use suggestion</button>
      </section>}
    </section>
  </>;
}
