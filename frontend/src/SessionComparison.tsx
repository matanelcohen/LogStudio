import * as Oui from "@opensearch-project/oui";
import { ArrowLeft, GitCompareArrows, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  cancelComparison, fetchComparison, fetchComparisonEvidence, fetchComparisonGroups, startComparison,
  type ComparisonChange, type ComparisonEvidence, type ComparisonGroup, type ComparisonGrouping, type ComparisonGroups,
  type ComparisonKind, type ComparisonScope, type ComparisonSide, type ComparisonSideName, type ComparisonSnapshot
} from "./comparison-api";
import { errorMessage, NumberFormatter, type SessionInfo } from "./model";
import { SelectControl } from "./ui";

const Changes = [
  { value: "all", label: "All changes" }, { value: "new", label: "Newly observed" }, { value: "resolved", label: "Resolved" },
  { value: "changed", label: "Count changed" }, { value: "unchanged", label: "Unchanged" }
] as const;
const Kinds = [{ value: "severity", label: "Severity summary" }, { value: "category", label: "Category summary" }, { value: "message", label: "Message groups" }] as const;
function SideDetails({ side, label, scope }: { side: ComparisonSide; label: string; scope: ComparisonScope }) {
  const filters = side.filters;
  return <section className="comparison-side" aria-label={`${label} run details`}>
    <h3>{label}: {side.session.name}</h3>
    <dl className="metadata">
      <dt>Session ID</dt><dd>{side.session.id}</dd>
      <dt>Started</dt><dd>{side.session.startedAt}</dd>
      <dt>Completed</dt><dd>{side.session.completedAt}</dd>
      <dt>Stored count</dt><dd>{NumberFormatter.format(side.session.entryCount)}</dd>
      <dt>Actual entries</dt><dd>{NumberFormatter.format(side.totalEntries)}</dd>
      <dt>Matched count</dt><dd>{NumberFormatter.format(side.matchedCount)}</dd>
      <dt>Duration</dt><dd>{side.durationMilliseconds === null ? "Unknown" : `${side.durationMilliseconds} ms`}</dd>
      <dt>Filter scope</dt><dd>{filters ? "Saved filters (frozen for this comparison)" : scope === "saved" ? "No saved filters — all history" : "All history"}</dd>
    </dl>
    {filters ? <dl className="metadata comparison-filters">
      <dt>Since (inclusive)</dt><dd>{filters.since || "Unbounded"}</dd>
      <dt>Until (inclusive)</dt><dd>{filters.until || "Unbounded"}</dd>
      <dt>Search</dt><dd>{filters.search ? JSON.stringify(filters.search) : "None"} · {filters.matchCase ? "Case-sensitive" : "Case-insensitive"}</dd>
      <dt>Levels</dt><dd>{filters.levels === null ? filters.severity : filters.levels.length ? filters.levels.join(", ") : "None (no levels selected)"}</dd>
      <dt>Category</dt><dd>{filters.category || "All categories"}</dd>
      <dt>Stream</dt><dd>{filters.stream}</dd>
      <dt>Include mode</dt><dd>{filters.includeMode}</dd>
      <dt>Conditions</dt><dd>{filters.conditions.length ? <ul>{filters.conditions.map((condition, index) =>
        <li key={index}>{condition.mode} · {condition.field} · {condition.operator} · {JSON.stringify(condition.value)}</li>)}</ul> : "None"}</dd>
    </dl> : <p className="muted">Time bounds: unbounded. No search, level, category, stream, or condition filters.</p>}
  </section>;
}
type EvidenceSelection = { group: ComparisonGroup; side: ComparisonSideName; cursors: number[] };

export function SessionComparison({ sessions, onClose, returnFocus }: {
  sessions: SessionInfo[];
  onClose(): void;
  returnFocus(): void;
}) {
  const [baselineId, setBaselineId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [grouping, setGrouping] = useState<ComparisonGrouping>("normalized");
  const [scope, setScope] = useState<ComparisonScope>("all");
  const [snapshot, setSnapshot] = useState<ComparisonSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ComparisonKind>("message");
  const [change, setChange] = useState<ComparisonChange | "all">("all");
  const [offset, setOffset] = useState(0);
  const [groups, setGroups] = useState<ComparisonGroups | null>(null);
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const [evidence, setEvidence] = useState<ComparisonEvidence | null>(null);
  const generation = useRef(0);
  const activeJob = useRef<string | null>(null);
  const evidenceReturn = useRef<HTMLButtonElement | null>(null);
  const eligible = sessions.filter(session => !session.isCurrent && session.completedAt !== null);
  const valid = eligible.some(session => session.id === baselineId) && eligible.some(session => session.id === candidateId) && baselineId !== candidateId;

  function release() {
    generation.current++;
    if (activeJob.current) void cancelComparison(activeJob.current).catch(() => {});
    activeJob.current = null;
  }
  function reset() {
    release();
    setSnapshot(null); setStarting(false); setNotice(null); setError(null);
    setGroups(null); setSelection(null); setEvidence(null); setOffset(0);
  }
  useEffect(() => () => { release(); }, []);

  function fail(reason: unknown) {
    setSnapshot(null); setGroups(null); setSelection(null); setEvidence(null);
    setError(errorMessage(reason)); setNotice("Comparison failed. Results and evidence have been cleared.");
  }
  async function compare() {
    if (!valid || starting) return;
    reset();
    const version = generation.current;
    setStarting(true);
    try {
      // Let creation return its ID even after close, so an in-flight job can be released.
      const result = await startComparison({ baselineId, candidateId, grouping, filterScope: scope });
      if (generation.current !== version) { void cancelComparison(result.id).catch(() => {}); return; }
      activeJob.current = result.id;
      setSnapshot(result);
    } catch (reason) {
      if (generation.current === version) fail(reason);
    } finally {
      if (generation.current === version) setStarting(false);
    }
  }
  async function cancel() {
    const id = activeJob.current;
    generation.current++;
    activeJob.current = null;
    setStarting(false); setSnapshot(null); setGroups(null); setSelection(null); setEvidence(null); setError(null);
    setNotice("Comparison cancelled. Results and evidence have been cleared.");
    const version = generation.current;
    if (id) try { await cancelComparison(id); } catch (reason) {
      if (generation.current === version) setError(`Cancellation could not be confirmed: ${errorMessage(reason)}`);
    }
  }
  const jobId = snapshot?.id;
  const jobState = snapshot?.state;
  useEffect(() => {
    if (!jobId || (jobState !== "running" && jobState !== "completed")) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const version = generation.current;
    async function poll() {
      try {
        const result = await fetchComparison(jobId!, controller.signal);
        if (!controller.signal.aborted && generation.current === version) {
          setSnapshot(result);
          if (result.state === "running" || result.state === "completed")
            timer = setTimeout(poll, result.state === "running" ? 800 : 2000);
        }
      } catch (reason) {
        if (!controller.signal.aborted && generation.current === version) fail(reason);
      }
    }
    timer = setTimeout(poll, jobState === "running" ? 800 : 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [jobId, jobState]);

  useEffect(() => {
    setGroups(null); setSelection(null); setEvidence(null);
    if (!jobId || jobState !== "completed") return;
    const controller = new AbortController();
    const version = generation.current;
    fetchComparisonGroups(jobId, kind, change, offset, controller.signal).then(result => {
      if (!controller.signal.aborted && generation.current === version) setGroups(result);
    }).catch(reason => { if (!controller.signal.aborted && generation.current === version) fail(reason); });
    return () => controller.abort();
  }, [jobId, jobState, kind, change, offset]);
  useEffect(() => {
    setEvidence(null);
    if (!selection || !snapshot || snapshot.state !== "completed") return;
    const controller = new AbortController();
    const version = generation.current;
    fetchComparisonEvidence(snapshot.id, selection.group.id, selection.side, snapshot[selection.side].session.id,
      selection.cursors.at(-1)!, controller.signal).then(result => {
      if (!controller.signal.aborted && generation.current === version) setEvidence(result);
    }).catch(reason => { if (!controller.signal.aborted && generation.current === version) fail(reason); });
    return () => controller.abort();
  }, [selection, jobId, jobState]);
  useEffect(() => {
    if (jobState && jobState !== "completed" && jobState !== "running") {
      setGroups(null); setSelection(null); setEvidence(null);
    }
  }, [jobState]);

  const completed = snapshot?.state === "completed";
  return <Oui.Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <Oui.DialogContent showCloseButton={false} className="comparison-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <div className="dialog-titlebar"><div className="dialog-icon"><GitCompareArrows size={20} /></div><div>
        <Oui.DialogTitle>Compare saved runs</Oui.DialogTitle>
        <Oui.DialogDescription>Read-only, local comparison of two completed saved sessions. Your explorer, query, and follow state stay unchanged.</Oui.DialogDescription>
      </div><Oui.Button variant="ghost" size="icon" className="icon-button" aria-label="Close comparison" onClick={onClose}><X size={18} /></Oui.Button></div>
      <div className="comparison-content">
        <div className="comparison-controls">
          <label>Baseline<SelectControl label="Baseline session" value={baselineId} onChange={value => { reset(); setBaselineId(value); if (value === candidateId) setCandidateId(""); }}
            choices={[{ value: "", label: "Choose baseline…" }, ...eligible.map(session => ({ value: session.id, label: `${session.name} · ${session.startedAt} · ${session.id}` }))]} /></label>
          <label>Candidate<SelectControl label="Candidate session" value={candidateId} onChange={value => { reset(); setCandidateId(value); }}
            choices={[{ value: "", label: "Choose candidate…" }, ...eligible.filter(session => session.id !== baselineId).map(session => ({ value: session.id, label: `${session.name} · ${session.startedAt} · ${session.id}` }))]} /></label>
          <label>Message grouping<SelectControl label="Message grouping" value={grouping} onChange={value => { reset(); setGrouping(value as ComparisonGrouping); }}
            choices={[{ value: "normalized", label: "Normalized messages" }, { value: "raw", label: "Raw messages (exact)" }]} /></label>
          <label>Filter scope<SelectControl label="Comparison filter scope" value={scope} onChange={value => { reset(); setScope(value as ComparisonScope); }}
            choices={[{ value: "all", label: "All saved events" }, { value: "saved", label: "Each session’s saved filters" }]} /></label>
        </div>
        {eligible.length < 2 && <p className="muted">Save at least two completed runs to compare. Current and unfinished sessions are excluded.</p>}
        <div className="comparison-actions"><Oui.Button variant="default" size="sm" disabled={!valid || starting} onClick={compare}>Compare runs</Oui.Button>
          {(starting || snapshot?.state === "running") && <Oui.Button variant="outline" size="sm" onClick={cancel}>Cancel comparison</Oui.Button>}</div>
        <p className="muted">Source: each full saved journal since its last clear, including records evicted from the retained window. Stored counts are session metadata; actual entries are journal totals, and matched counts reflect the chosen filters.</p>
        <p className="comparison-caution">Counts describe observed events, not root causes. Normalization can merge distinct messages (collisions); use raw grouping and original evidence to verify. Durations and counts are not rate-normalized.</p>
        {starting && <p role="status">Starting comparison…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <Oui.Alert variant="destructive" role="alert" className="notice danger">{error}</Oui.Alert>}
        {snapshot && <>
          <p role="status">Comparison {snapshot.state} · Phase: {snapshot.phase} · {NumberFormatter.format(snapshot.processedEntries)} / {NumberFormatter.format(snapshot.totalEntries)} entries processed</p>
          {!["running", "completed"].includes(snapshot.state) && <Oui.Alert variant="destructive" role="alert" className="notice danger">
            Comparison {snapshot.state}. {snapshot.error ?? (snapshot.state === "invalidated" ? "A source history changed or was deleted." : "")} Results and evidence have been cleared.
          </Oui.Alert>}
          {(snapshot.state === "running" || completed) && <>
            <p><strong>{snapshot.grouping === "raw" ? "Raw grouping rule" : "Normalization rule"}:</strong> {snapshot.normalizationRule}</p>
            <div className="comparison-sides"><SideDetails label="Baseline" side={snapshot.baseline} scope={scope} /><SideDetails label="Candidate" side={snapshot.candidate} scope={scope} /></div>
          </>}
        </>}
        {completed && <section aria-label="Comparison results" hidden={selection !== null}>
          <div className="comparison-tabs" role="group" aria-label="Comparison summaries">{Kinds.map(item =>
            <Oui.Button key={item.value} variant={kind === item.value ? "default" : "outline"} size="sm" aria-pressed={kind === item.value}
              onClick={() => { setKind(item.value); setOffset(0); }}>{item.label}</Oui.Button>)}</div>
          <div className="comparison-tabs" role="group" aria-label="Group change filter">{Changes.map(item =>
            <Oui.Button key={item.value} variant={change === item.value ? "default" : "outline"} size="sm" aria-pressed={change === item.value}
              onClick={() => { setChange(item.value); setOffset(0); }}>{item.label}</Oui.Button>)}</div>
          <p className="muted">Delta = candidate − baseline. Newly observed and resolved are relative to the baseline.</p>
          {!groups ? <p role="status">Loading comparison groups…</p> : <>
            <div className="comparison-table-scroll"><table className="comparison-table"><caption>{Kinds.find(item => item.value === kind)?.label}</caption>
              <thead><tr><th scope="col">Group</th><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Delta</th><th scope="col">Change</th><th scope="col">Original evidence</th></tr></thead>
              <tbody>{groups.groups.map(group => <tr key={group.id}><th scope="row"><span>{group.label}</span>
                {kind === "message" && <small>{group.severity ?? "All severities"} · {group.category ?? "No category"}</small>}</th>
                <td>{NumberFormatter.format(group.baselineCount)}</td><td>{NumberFormatter.format(group.candidateCount)}</td>
                <td>{group.delta > 0 ? "+" : ""}{group.delta}</td><td>{Changes.find(item => item.value === group.change)?.label}</td>
                <td><div className="comparison-actions">{(["baseline", "candidate"] as const).map(side =>
                  <Oui.Button key={side} variant="outline" size="sm" disabled={group[`${side}Count`] === 0}
                    aria-label={`View ${side} evidence for ${group.label}`} onClick={(event: MouseEvent<HTMLButtonElement>) => {
                      evidenceReturn.current = event.currentTarget;
                      setSelection({ group, side, cursors: [0] });
                    }}>{side === "baseline" ? "Baseline" : "Candidate"}</Oui.Button>)}</div></td></tr>)}</tbody>
            </table></div>
            {!groups.groups.length && <p>No groups match this change filter.</p>}
            <div className="comparison-paging"><Oui.Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous groups</Oui.Button>
              <span>{groups.total ? `${offset + 1}–${offset + groups.groups.length}` : "0"} of {groups.total} groups · up to 50 per page</span>
              <Oui.Button variant="outline" size="sm" disabled={offset + 50 >= groups.total} onClick={() => setOffset(value => value + 50)}>Next groups</Oui.Button></div>
          </>}
        </section>}
        {completed && selection && <section aria-label="Comparison evidence">
          <Oui.Button variant="outline" size="sm" onClick={() => { setSelection(null); requestAnimationFrame(() => evidenceReturn.current?.isConnected && evidenceReturn.current.focus()); }}><ArrowLeft size={14} />Back to comparison results</Oui.Button>
          <h3>Original evidence: {selection.group.label}</h3>
          <p>{selection.side === "baseline" ? "Baseline" : "Candidate"} · {snapshot[selection.side].session.name} · session {snapshot[selection.side].session.id}</p>
          <div className="comparison-actions">{(["baseline", "candidate"] as const).map(side =>
            <Oui.Button key={side} variant="outline" size="sm" aria-pressed={selection.side === side} disabled={!selection.group[`${side}Count`]}
              onClick={() => setSelection({ group: selection.group, side, cursors: [0] })}>Read {side} evidence</Oui.Button>)}</div>
          {!evidence ? <p role="status">Loading original evidence…</p> : <>
            <p className="muted">Page {selection.cursors.length} · {evidence.entries.length} original records · up to 50 per page, chronological within this session. IDs are session-local, never cross-session matches.</p>
            <div className="comparison-evidence-list">{evidence.entries.map(entry => <article key={`${evidence.sessionId}:${entry.id}`} className="comparison-record">
              <dl className="metadata"><dt>Timestamp</dt><dd>{entry.timestamp}</dd><dt>Entry ID</dt><dd>{entry.id}</dd>
                <dt>Severity</dt><dd>{entry.severity}</dd><dt>Category</dt><dd>{entry.category ?? "No category"}</dd><dt>Stream</dt><dd>{entry.stream}</dd></dl>
              <strong>Raw message{entry.isPartial ? " (partial)" : ""}</strong><pre tabIndex={0} aria-label={`Raw message for entry ${entry.id}`}>{entry.message}</pre>
            </article>)}</div>
            {!evidence.entries.length && <p>No matching original records on this side.</p>}
            <div className="comparison-paging"><Oui.Button variant="outline" size="sm" disabled={selection.cursors.length < 2} onClick={() => setSelection({ ...selection, cursors: selection.cursors.slice(0, -1) })}>Previous evidence</Oui.Button>
              <span>Evidence page {selection.cursors.length}</span><Oui.Button variant="outline" size="sm" disabled={evidence.nextAfter === null}
                onClick={() => { if (evidence.nextAfter !== null) setSelection({ ...selection, cursors: [...selection.cursors, evidence.nextAfter] }); }}>Next evidence</Oui.Button></div>
          </>}
        </section>}
      </div>
    </Oui.DialogContent>
  </Oui.Dialog>;
}
