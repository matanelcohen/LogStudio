import * as Oui from "@opensearch-project/oui";
import { ArrowUpRight, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { connectCopilot } from "./api";
import { askAnalytics } from "./analytics-api";
import type { AnalyticsInsight, GraphDefinition } from "./analytics-model";
import { errorMessage, MaximumChatQuestionLength, NumberFormatter, type CopilotConnection } from "./model";
import { SelectControl } from "./ui";

const MarkdownPlugins = [remarkGfm];
export function AnalyticsCopilot({ parameters, graph, disabled, onGraph }: {
  parameters: string; graph: GraphDefinition | null; disabled: boolean; onGraph(graph: GraphDefinition): void;
}) {
  const [connection, setConnection] = useState<CopilotConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AnalyticsInsight | null>(null);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);

  async function connect() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const connection = await connectCopilot();
      if (mounted.current) setConnection(connection);
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function analyze(prompt: string) {
    if (inFlight.current || disabled || !connection) return;
    inFlight.current = true; setBusy(true); setError(null);
    request.current = new AbortController();
    try {
      const result = await askAnalytics(new URLSearchParams(parameters), prompt, graph,
        { ...(model ? { model } : {}), ...(reasoning ? { reasoningEffort: reasoning } : {}) }, request.current.signal);
      if (mounted.current) setResult(result);
    } catch (error) {
      if (mounted.current && !request.current.signal.aborted) setError(errorMessage(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const selectedModel = connection?.models.find(candidate => candidate.id === model);
  return <aside className="analytics-card analytics-copilot" aria-label="Copilot analytics">
    <header><span className="analytics-ai-icon"><Sparkles size={18} /></span><div><h3>Copilot insights</h3><p>Your data, a clearer story</p></div></header>
    <p className="muted">Explain patterns or describe a graph to create. Uses your local Copilot CLI and its signed-in account.</p>
    <p className="analytics-privacy">Only sent when you ask: matching counts, capture intervals, application/category names, current graph, and your question. Log messages are not sent.</p>
    {!connection ? <Oui.Button variant="outline" size="sm" disabled={busy} onClick={() => { void connect(); }}>
      {busy ? <LoaderCircle size={14} className="analytics-spinner" /> : <Sparkles size={14} />}Connect Copilot</Oui.Button> : <>
      <div className="analytics-ai-starters">{["Explain these trends", "Graph errors by category"].map(prompt =>
        <Oui.Button variant="outline" size="sm" key={prompt} disabled={busy || disabled} onClick={() => { setQuestion(prompt); void analyze(prompt); }}>{prompt}<ArrowUpRight size={13} /></Oui.Button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void analyze(question.trim()); }}>
        <label htmlFor="analyticsQuestion">Ask about this data</label>
        <Oui.Textarea id="analyticsQuestion" value={question} maxLength={MaximumChatQuestionLength} rows={3} disabled={busy}
          placeholder="Show me when errors spike…" onChange={event => setQuestion(event.target.value)} />
        <div className="analytics-ai-options"><SelectControl label="Analytics AI model" value={model} disabled={busy} onChange={value => { setModel(value); setReasoning(""); }}
          choices={[{ value: "", label: "CLI default" }, ...connection.models.map(model => ({ value: model.id, label: model.name }))]} />
          {!!selectedModel?.reasoningEfforts.length && <SelectControl label="Analytics reasoning effort" value={reasoning} disabled={busy} onChange={setReasoning}
            choices={[{ value: "", label: "Default reasoning" }, ...selectedModel.reasoningEfforts.map(value => ({ value, label: value }))]} />}</div>
        <Oui.Button type="submit" variant="default" size="sm" disabled={busy || disabled || !question.trim()}><Sparkles size={14} />Generate insight</Oui.Button>
      </form>
    </>}
    {busy && <p className="analytics-ai-busy" role="status"><LoaderCircle size={15} className="analytics-spinner" />{connection ? "Analyzing this snapshot…" : "Connecting to Copilot…"}</p>}
    {error && <Oui.Alert variant="destructive" className="notice danger" role="alert">{error}</Oui.Alert>}
    {result && <div className="analytics-ai-result">
      <span className="workspace-kicker">COPILOT ANALYSIS</span>
      <div className="copilot-markdown"><Markdown remarkPlugins={MarkdownPlugins}
        components={{ img: ({ alt }) => <span>{alt || "Image omitted"}</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{result.insight}</Markdown></div>
      <p className="muted">Analyzed {NumberFormatter.format(result.contextEntryCount)} matching records through #{result.throughId}. This is a snapshot, not a live diagnosis. AI explanations may be incorrect.</p>
      <div className="analytics-graph-suggestion"><span>Suggested graph</span><strong>{result.graph.name}</strong>
        <Oui.Button variant="outline" size="sm" onClick={() => onGraph(result.graph)}>Open in Graphs<ArrowUpRight size={14} /></Oui.Button></div>
    </div>}
  </aside>;
}
