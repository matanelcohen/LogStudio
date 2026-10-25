import * as Oui from "@opensearch-project/oui";
import { ArrowDown, ArrowUp, Braces, Copy, Filter, MinusCircle, PlusCircle, X } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import {
  MaximumConditionValueLength, SeverityLabels, errorMessage,
  type ConditionField, type ConditionMode, type LogCondition, type LogEntry, type Notice, type ViewerStatus
} from "./model";

function formatMessage(message: string): string | null {
  if (!/^\s*[\[{]/.test(message)) return null;
  try {
    JSON.parse(message);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return null;
    throw error;
  }
  // Keep number lexemes, duplicate keys and escapes intact; parse/stringify changes them.
  const tokens = message.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g) ?? [];
  let depth = 0;
  let result = "";
  for (const [index, token] of tokens.entries()) {
    if (token === "{" || token === "[") {
      result += token;
      if (++depth > 64) return null;
      if (tokens[index + 1] !== (token === "{" ? "}" : "]")) result += "\n" + "  ".repeat(depth);
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== (token === "}" ? "{" : "[")) result += "\n" + "  ".repeat(depth);
      result += token;
    } else if (token === ",") result += ",\n" + "  ".repeat(depth);
    else if (token === ":") result += ": ";
    else result += token;
    if (result.length > 262144) return null;
  }
  return result;
}

export function Inspector({ entry, entries, status, onSelect, onClose, onCondition, onDraft, onNotice }: {
  entry: LogEntry | null;
  entries: LogEntry[];
  status: ViewerStatus | null;
  onSelect(entry: LogEntry): void;
  onClose(): void;
  onCondition(condition: LogCondition): void;
  onDraft(condition: LogCondition): void;
  onNotice(notice: Notice): void;
}) {
  const [formatJson, setFormatJson] = useState(false);
  const formatted = useMemo(() => entry ? formatMessage(entry.message) : null, [entry?.message]);
  const position = entry ? entries.findIndex(candidate => candidate.id === entry.id) : -1;
  const previous = position > 0 ? entries[position - 1] : undefined;
  const next = position >= 0 ? entries[position + 1] : undefined;

  function filter(mode: ConditionMode, field: ConditionField) {
    if (!entry) return;
    const selection = window.getSelection();
    const messageElement = document.getElementById("detailMessage");
    const selectedText = selection && messageElement?.contains(selection.anchorNode) ? selection.toString() : "";
    const value = field === "category" ? entry.category : field === "level" ? entry.severity : selectedText || entry.message.trim();
    if (!value) return;
    const isDraft = field === "message" || value.length > MaximumConditionValueLength;
    const condition: LogCondition = { mode, field, operator: isDraft ? "contains" : "equals", value: value.slice(0, MaximumConditionValueLength) };
    if (isDraft) onDraft(condition);
    else onCondition(condition);
  }

  async function copy(messageOnly = false) {
    if (!entry) return;
    if (!navigator.clipboard?.writeText) return onNotice({ tone: "danger", message: "Clipboard access is unavailable. Export JSONL to save the entries." });
    try {
      await navigator.clipboard.writeText(messageOnly ? entry.message : JSON.stringify(entry, null, 2));
      onNotice({ tone: "info", message: messageOnly ? `Copied message from entry #${entry.id}.` : `Copied entry #${entry.id} as JSON.` });
    } catch (error) {
      onNotice({ tone: "danger", message: `Copy failed: ${errorMessage(error)}` });
    }
  }

  return (
    <aside className="details-panel" aria-label="Entry inspector">
      <div className="panel-header"><h2>Inspector</h2><div className="inspector-header-actions">
        <Oui.Button variant="outline" size="sm" id="copyEntry" className="small" disabled={!entry} onClick={() => copy()}><Copy size={13} /> JSON</Oui.Button>
        <Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Close inspector" onClick={onClose}><X size={16} /></Oui.Button>
      </div></div>
      {!entry ? <div id="noSelection" className="details-placeholder"><Filter size={25} /><h3>Select an entry</h3><p>Inspect full text and metadata, then include or exclude its fields directly.</p><p className="muted">Use Enter on a focused log row. Arrow keys move between entries.</p></div> : (
        <div id="selectedDetails" className="selected-details">
          <div className="inspector-navigation" role="group" aria-label="Navigate visible entries">
            <Oui.Button variant="outline" size="icon" aria-label="Previous entry" disabled={!previous} onClick={() => { if (previous) onSelect(previous); }}><ArrowUp size={14} /></Oui.Button>
            <span role="status">{position >= 0 ? `${position + 1} of ${entries.length} on page` : "Selection outside current page"}</span>
            <Oui.Button variant="outline" size="icon" aria-label="Next entry" disabled={!next} onClick={() => { if (next) onSelect(next); }}><ArrowDown size={14} /></Oui.Button>
          </div>
          <div className="entry-title"><Oui.Badge variant="outline" className={`severity-badge ${entry.severity}`}>{SeverityLabels[entry.severity]}</Oui.Badge><span>Entry #{entry.id}</span></div>
          <dl className="metadata">
            <dt>Sequence</dt><dd id="detailId">{entry.id}</dd>
            <dt>Captured (UTC)</dt><dd id="detailTime">{entry.timestamp.replace("T", "\n").replace(/(?:\+00:00|Z)$/, " UTC")}</dd>
            <dt>Level</dt><dd id="detailSeverity">{SeverityLabels[entry.severity]}</dd>
            <dt>Stream</dt><dd id="detailStream">{entry.stream}</dd>
            <dt>Category</dt><dd id="detailCategory">{(entry.category ?? "Uncategorized").split(".").map((part, index) => <Fragment key={index}>{index > 0 && <><span>.</span><wbr /></>}{part}</Fragment>)}</dd>
            <dt>Line type</dt><dd id="detailPartial">{entry.isPartial ? "Partial / continued chunk" : "Complete line"}</dd>
          </dl>
          {status && entry.id < status.firstId && <Oui.Alert variant="default" role="status" className="notice warning">This entry expired under the retention limit. Its selected details remain here.</Oui.Alert>}
          <div className="message-toolbar"><h3>Message</h3>
            {formatted !== null && <Oui.Button variant="outline" size="sm" aria-pressed={formatJson} onClick={() => setFormatJson(value => !value)}><Braces size={13} />Format JSON</Oui.Button>}
            <Oui.Button variant="outline" size="sm" onClick={() => copy(true)}><Copy size={13} />Copy message</Oui.Button>
          </div>
          <pre id="detailMessage">{formatJson && formatted !== null ? formatted : entry.message}</pre>
          <h3>Quick filters</h3>
          <div className="entry-filter-actions">
            <Oui.Button variant="outline" size="sm" id="includeMessage" onClick={() => filter("include", "message")}><PlusCircle size={13} /> Include text…</Oui.Button>
            <Oui.Button variant="outline" size="sm" id="excludeMessage" onClick={() => filter("exclude", "message")}><MinusCircle size={13} /> Exclude pattern…</Oui.Button>
            <Oui.Button variant="outline" size="sm" id="includeCategory" aria-label="Include category" disabled={!entry.category} onClick={() => filter("include", "category")}><PlusCircle size={13} /> Category</Oui.Button>
            <Oui.Button variant="outline" size="sm" id="excludeCategory" aria-label="Exclude category" disabled={!entry.category} onClick={() => filter("exclude", "category")}><MinusCircle size={13} /> Category</Oui.Button>
            <Oui.Button variant="outline" size="sm" id="includeLevel" aria-label="Include level" onClick={() => filter("include", "level")}><PlusCircle size={13} /> Level</Oui.Button>
            <Oui.Button variant="outline" size="sm" id="excludeLevel" aria-label="Exclude level" onClick={() => filter("exclude", "level")}><MinusCircle size={13} /> Level</Oui.Button>
          </div>
          <p className="muted inspector-note">Full history stays on disk. Applying a filter never deletes a log.</p>
        </div>
      )}
    </aside>
  );
}
