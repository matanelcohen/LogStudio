import { MessageSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askCopilot, connectCopilot } from "./api";
import { errorMessage, MaximumChatQuestionLength, NumberFormatter, type ChatMessage, type ViewerStatus } from "./model";

export function CopilotChatPanel({ status, sessionId, hidden = false, onClose, returnFocus }: {
  status: ViewerStatus | null;
  sessionId: string;
  hidden?: boolean;
  onClose(): void;
  returnFocus(): void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const entryCount = Math.max(0, (status?.lastId ?? 0) - (status?.clearedThroughId ?? 0));

  useEffect(() => {
    if (version) questionInput.current?.focus();
    else connectButton.current?.focus();
  }, [version]);

  function close() {
    if (busy) return;
    onClose();
    returnFocus();
  }

  async function connect() {
    if (busy) return;
    setBusy(true); setError(null);
    try { setVersion(await connectCopilot()); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function submit() {
    const text = question.trim();
    if (!text || !version || busy || !entryCount) return;
    setBusy(true); setError(null);
    try {
      const history = messages.slice(-6).map(message => ({ ...message, content: message.content.slice(0, MaximumChatQuestionLength) }));
      const response = await askCopilot(sessionId, text, history);
      setMessages([...messages.slice(-6), { role: "user", content: text }, { role: "assistant", content: response.answer }]);
      setQuestion("");
      setContextNote(`Full session file available: ${NumberFormatter.format(response.contextEntryCount)} log records. Copilot may read relevant portions.`);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return <aside className="copilot-panel" hidden={hidden} aria-labelledby="copilotTitle" onKeyDown={event => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); close(); }
  }}>
        <div className="dialog-titlebar"><div className="dialog-icon"><MessageSquare size={21} /></div><div>
          <h2 id="copilotTitle">Ask Copilot about logs</h2>
          <p>Read-only chat through your local GitHub Copilot CLI.</p>
        </div><button className="icon-button" disabled={busy} aria-label="Close Copilot chat" onClick={close}><X size={17} /></button></div>
        <div className="copilot-content">
          <p><strong>{status?.applicationName ?? "Selected session"}</strong> · Full session ({NumberFormatter.format(entryCount)} log records).</p>
          <p className="muted">Every question provides the complete session log file, including new entries. Filters and paging do not limit chat. Previously deleted records are unavailable.</p>
          <p>The CLI runs locally, but questions, log text, and recent conversation are sent to GitHub Copilot's service.
            Logs are not automatically redacted. Do not share secrets or sensitive data. Copilot's service may retain submitted data.</p>
          {!version ? <div className="copilot-setup">
            <p>Install the current GitHub Copilot CLI and run <code>copilot login</code> in a terminal first. A Copilot entitlement and internet connection are required.</p>
            <button ref={connectButton} className="primary" disabled={busy} onClick={connect}>{busy ? "Connecting…" : "Connect local Copilot"}</button>
          </div> : <>
            <p className="muted">Connected CLI: {version}. Copilot can read the session file, but cannot run commands or change logs.</p>
            <div className="copilot-messages" role="log" aria-label="Copilot conversation" aria-live="polite">
              {messages.map((message, index) => <div className={`copilot-message ${message.role}`} key={index}>
                <strong>{message.role === "user" ? "You" : "Copilot"}</strong><p>{message.content}</p>
              </div>)}
            </div>
            <form onSubmit={event => { event.preventDefault(); void submit(); }}>
              <label htmlFor="copilotQuestion">Question about these logs</label>
              <textarea ref={questionInput} id="copilotQuestion" value={question} maxLength={MaximumChatQuestionLength} disabled={busy}
                rows={3} placeholder="What caused the errors? Cite the log IDs." onChange={event => setQuestion(event.target.value)} />
              <div className="dialog-footer">
                <button type="button" disabled={busy || !messages.length} onClick={() => { setMessages([]); setContextNote(null); setError(null); }}>Clear chat</button>
                <button type="submit" className="primary" disabled={busy || !question.trim() || !entryCount}>{busy ? "Asking Copilot…" : "Ask Copilot"}</button>
              </div>
            </form>
          </>}
          {busy && <p role="status">{version ? "Waiting for Copilot (up to two minutes)…" : "Checking the local CLI…"}</p>}
          {contextNote && <p className="muted" role="status">{contextNote} AI answers can be wrong; verify against the logs.</p>}
          {error && <p className="notice danger" role="alert">{error}</p>}
        </div>
  </aside>;
}
