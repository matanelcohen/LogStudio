import * as Oui from "@opensearch-project/oui";
import { Copy, Filter, MinusCircle, PlusCircle, X } from "lucide-react";
import { Fragment } from "react";
import {
  MaximumConditionValueLength, SeverityLabels, errorMessage,
  type ConditionField, type ConditionMode, type LogCondition, type LogEntry, type Notice, type ViewerStatus
} from "./model";

export function Inspector({ entry, status, onClose, onCondition, onDraft, onNotice }: {
  entry: LogEntry | null;
  status: ViewerStatus | null;
  onClose(): void;
  onCondition(condition: LogCondition): void;
  onDraft(condition: LogCondition): void;
  onNotice(notice: Notice): void;
}) {
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

  async function copy() {
    if (!entry) return;
    if (!navigator.clipboard?.writeText) return onNotice({ tone: "danger", message: "Clipboard access is unavailable. Export JSONL to save the entries." });
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
      onNotice({ tone: "info", message: `Copied entry #${entry.id} as JSON.` });
    } catch (error) {
      onNotice({ tone: "danger", message: `Copy failed: ${errorMessage(error)}` });
    }
  }

  return (
    <aside className="details-panel" aria-label="Entry inspector">
      <div className="panel-header"><h2>Inspector</h2><div className="inspector-header-actions">
        <Oui.Button variant="outline" size="sm" id="copyEntry" className="small" disabled={!entry} onClick={copy}><Copy size={13} /> JSON</Oui.Button>
        <Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Close inspector" onClick={onClose}><X size={16} /></Oui.Button>
      </div></div>
      {!entry ? <div id="noSelection" className="details-placeholder"><Filter size={25} /><h3>Select an entry</h3><p>Inspect full text and metadata, then include or exclude its fields directly.</p><p className="muted">Use Enter on a focused log row. Arrow keys move between entries.</p></div> : (
        <div id="selectedDetails" className="selected-details">
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
          <h3>Message</h3>
          <pre id="detailMessage">{entry.message}</pre>
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
